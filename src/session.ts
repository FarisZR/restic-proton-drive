import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { OpenPGPCryptoWithCryptoProxy, ProtonDriveClient, type DriveEvent, VERSION } from '@protontech/drive-sdk';
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
    constructor(private path: string, private key?: Buffer) {
        if (key && key.length !== 32) throw new Error('Session key must contain 32 bytes');
    }
    private encode(snapshot: Snapshot) {
        const content = JSON.stringify(snapshot);
        if (!this.key) return content;
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
        cipher.setAAD(Buffer.from('restic-proton-drive/session/v1'));
        const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
        return JSON.stringify({ version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    }
    async load() {
        if (!await Bun.file(this.path).exists()) return null;
        const text = await Bun.file(this.path).text();
        const envelope = JSON.parse(text);
        let content = text;
        if ('version' in envelope) {
            if (envelope.version !== 1 || !this.key) throw new Error('Session encryption key is missing or format is unsupported');
            try {
                const nonce = Buffer.from(envelope.nonce, 'base64');
                const tag = Buffer.from(envelope.tag, 'base64');
                if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid session envelope');
                const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
                decipher.setAAD(Buffer.from('restic-proton-drive/session/v1'));
                decipher.setAuthTag(tag);
                content = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
            } catch { throw new Error('Cannot decrypt session: incorrect key or damaged session file'); }
        }
        const snapshot = parseStoredSnapshot(content);
        if (!snapshot) throw new Error('Invalid session file; restore it or remove it before logging in');
        if (this.key && content === text) await this.save(snapshot); // atomic legacy migration
        return snapshot;
    }
    save(snapshot: Snapshot) {
        const content = this.encode(snapshot);
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
    const config = getConfig({ appVersion: 'external-drive-restic_backup@0.2.0-alpha',
        sdkVersion: VERSION, clientUidPrefix: 'restic-backup', enablePersistedEvents: true });
    if (config.baseUrl !== 'drive-api.proton.me') throw new Error('Only the official Drive endpoint is supported');
    await Promise.all([config.appDir, config.cacheDir, config.logDir].map(p => mkdir(p, { recursive: true, mode: 0o700 })));
    const { telemetry, flush } = initTelemetry(config);
    const logger = telemetry.getLogger('adapter');
    const eventsProvider = await PersistedEventsProvider.open(logger, config.appDir);
    if (!eventsProvider.canListenForEvents()) throw new Error('Another process is using this session directory');
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), endpoint => endpoint.clearKeyStore());
    let sessionKey: Buffer | undefined;
    if (config.credentialsStore === 'unsafe_file') {
        const keyPath = process.env.SESSION_KEY_FILE;
        if (keyPath) {
            const key = (await Bun.file(keyPath).text()).trim();
            if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('SESSION_KEY_FILE must contain a 64-digit hexadecimal key');
            sessionKey = Buffer.from(key, 'hex');
        } else throw new Error('Set SESSION_KEY_FILE to encrypt the file session, or use pass/keychain');
    }
    const credentials = config.credentialsStore === 'unsafe_file'
        ? new Credentials(new FileSessionStore(join(config.appDir, 'auth-session.json'), sessionKey), logger)
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
    let listener = async (_event: DriveEvent) => {};
    const eventSdk = {
        subscribeToDriveEvents: (callback: (event: DriveEvent) => Promise<void>) => sdk.subscribeToDriveEvents(async event => {
            await listener(event); await callback(event);
        }),
        subscribeToTreeEvents: (scope: string, callback: (event: DriveEvent) => Promise<void>) => sdk.subscribeToTreeEvents(scope, async event => {
            await listener(event); await callback(event);
        }),
    };
    const eventsManager = await Manager.create(logger, eventSdk, eventSdk, eventsProvider, auth.isLoggedIn());
    return { sdk, auth, config, eventsManager, onEvent: (callback: typeof listener) => { listener = callback; }, dispose: async () => {
        await eventsManager.dispose(); await eventsProvider.dispose(); await flush();
    } };
}
