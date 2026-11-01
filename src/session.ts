import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { OpenPGPCryptoWithCryptoProxy, ProtonDriveClient, VERSION } from '@protontech/drive-sdk';
import { ApiClient, initAccount } from 'proton-drive-sdk-account';
import { DriveAccountAdapter } from '../sdk/cli/src/api/driveAccountAdapter';
import { HTTPClient } from '../sdk/cli/src/api/httpClient';
import { createServerTimeAfterResponseHook } from '../sdk/cli/src/api/serverTimeHook';
import { createCaches } from '../sdk/cli/src/cache';
import { getConfig } from '../sdk/cli/src/config';
import { initCredentials } from '../sdk/cli/src/credentials';
import { Credentials } from '../sdk/cli/src/credentials/credentials';
import { parseStoredSnapshot } from '../sdk/cli/src/credentials/parseCredentials';
import type { Credentials as Snapshot } from '../sdk/cli/src/credentials/interface';
import { getOrGenerateClientUid } from '../sdk/cli/src/clientUid';
import { Manager, PersistedEventsProvider } from '../sdk/cli/src/events';
import { initTelemetry } from '../sdk/cli/src/telemetry';

export async function atomicWrite(path: string, content: string) {
    const file = await open(`${path}.tmp`, 'w', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(`${path}.tmp`, path);
    const directory = await open(join(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
}

// A serialized, atomic session store avoids a torn token file after a crash.
export class FileSessionStore {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private path: string) {}
    async load() {
        if (!await Bun.file(this.path).exists()) return null;
        const snapshot = parseStoredSnapshot(await Bun.file(this.path).text());
        if (!snapshot) throw new Error('Invalid session file; restore it or remove it before logging in');
        return snapshot;
    }
    save(snapshot: Snapshot) {
        const content = JSON.stringify(snapshot);
        const task = this.tail.then(() => atomicWrite(this.path, content));
        this.tail = task.catch(() => {});
        return task;
    }
    async remove() { await this.tail; await rm(this.path, { force: true }); }
}

export function assertRequirements(headers: Headers, version = VERSION) {
    const platform = headers.get('x-pm-drive-platform-requirements') || '';
    for (const field of platform.split(/\s+/)) if (field.startsWith('required=')) {
        const required = field.slice(9);
        if (!/^\d+\.\d+\.\d+$/.test(required) || !Bun.semver.satisfies(version, `>=${required}`))
            throw new Error(`Drive requires SDK ${required}; installed ${version}. Update the image.`);
    }
    const features = headers.get('x-pm-drive-requirements') || '';
    for (const field of features.split(/\s+/)) if (field.startsWith('drive=')) {
        const value = field.slice(6);
        const mask = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(mask) || mask < 0 || (BigInt(mask) & ~1n) !== 0n)
            throw new Error('Drive requires unsupported features. Update the image.');
    }
}

export async function initSession() {
    process.env.PROTON_DRIVE_LOG_LEVEL ||= 'WARNING';
    const config = getConfig({ appVersion: 'external-drive-restic_backup@0.1.0-alpha',
        sdkVersion: VERSION, clientUidPrefix: 'restic-backup', enablePersistedEvents: true });
    if (config.baseUrl !== 'drive-api.proton.me') throw new Error('Only the official Drive endpoint is supported');
    await Promise.all([config.appDir, config.cacheDir, config.logDir].map(p => mkdir(p, { recursive: true, mode: 0o700 })));
    const { telemetry, flush } = initTelemetry(config);
    const logger = telemetry.getLogger('adapter');
    const eventsProvider = await PersistedEventsProvider.open(logger, config.appDir);
    if (!eventsProvider.canListenForEvents()) throw new Error('Another process is using this session directory');
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), endpoint => endpoint.clearKeyStore());
    const credentials = config.credentialsStore === 'unsafe_file'
        ? new Credentials(new FileSessionStore(join(config.appDir, 'auth-session.json')), logger)
        : initCredentials(config, logger);
    const apiClient = new ApiClient({ baseUrl: config.baseUrl, appVersion: config.appVersion, credentials, logger,
        headers: { 'x-pm-drive-sdk-version': VERSION },
        afterResponseHooks: [(_request, _options, response) => { assertRequirements(response.headers); }, createServerTimeAfterResponseHook()] });
    const { auth, addresses, srp } = await initAccount({ authClientId: config.authClientId, apiClient, credentials,
        cryptoProxy: CryptoProxy, srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp }, logger });
    const caches = createCaches(config, credentials, logger);
    const sdk = new ProtonDriveClient({ config: { baseUrl: config.baseUrl, clientUid: await getOrGenerateClientUid(config, logger) },
        httpClient: new HTTPClient(apiClient), ...caches, telemetry,
        openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
        account: new DriveAccountAdapter(addresses), srpModule: srp, latestEventIdProvider: eventsProvider });
    const eventsManager = await Manager.create(logger, sdk, sdk, eventsProvider, auth.isLoggedIn());
    return { sdk, auth, config, eventsManager, dispose: async () => {
        await eventsManager.dispose(); await eventsProvider.dispose(); await flush();
    } };
}
