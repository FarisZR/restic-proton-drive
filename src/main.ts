import { httpServer } from './http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { initSession, atomicWrite } from './session';
import { randomBytes } from 'node:crypto';
import { readPasswordLine } from '../sdk/cli/src/cli/readPasswordLine';
import { DriveStore } from './store';
import { handler } from './rest';
import { headlessLogin } from './login';
import { PackCache } from './pack-cache';
import { VERSION } from '@protontech/drive-sdk';

process.umask(0o077);
const command = process.argv[2];
const state = process.env.PROTON_DRIVE_CACHE_DIR;
if (command === 'version') { console.log(`restic-proton-drive 0.3.0; Bun ${Bun.version}; SDK ${VERSION}`); process.exit(0); }
if (command === 'health') {
    if (!state) throw new Error('PROTON_DRIVE_CACHE_DIR is required');
    const token = (await Bun.file(process.env.REST_TOKEN_FILE || join(state, 'rest-token')).text()).trim();
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 8000}/health`, {
        headers: { authorization: `Basic ${Buffer.from(`backup:${token}`).toString('base64')}` }, signal: AbortSignal.timeout(4000) });
    process.exit(response.ok ? 0 : 1);
}
if (!['login', 'create', 'serve'].includes(command)) {
    console.log('Usage: login [username] | create <folder-name> | serve | health | version');
    process.exit(1);
}
const app = await initSession();
try {
    if (command === 'login') {
        console.log('This is a third-party application not officially supported by Proton.');
        const username = process.argv[3];
        if (username && username !== '--headless') {
            if (username.startsWith('-')) throw new Error('Usage: login [--headless | username]');
            const password = await readPasswordLine('Password: ');
            await app.auth.authViaPassword(username, password);
        } else {
            await headlessLogin(app.auth);
        }
        console.log('Signed in.');
        await app.dispose();
        process.exit(0);
    }
    if (!app.auth.isLoggedIn()) throw new Error('Run login first');
    if (command === 'create') {
        if (await Bun.file(join(app.config.appDir, 'repository.uid')).exists()) throw new Error('A repository is already configured in this state directory');
        const folderName = process.argv[3];
        if (!folderName || /[\\/]/.test(folderName)) throw new Error('Provide a single folder name');
        const root = await app.sdk.getMyFilesRootFolder();
        const folder = await app.sdk.createFolder(root.uid, folderName);
        await atomicWrite(join(app.config.appDir, 'repository.uid'), folder.uid);
        for (const filename of ['rest-token']) {
            const path = join(app.config.appDir, filename);
            if (!await Bun.file(path).exists()) await atomicWrite(path, randomBytes(32).toString('hex') + '\n');
        }
        console.log(`Created ${folderName}. Ready to start the server.`);
        await app.dispose();
        process.exit(0);
    }
    const uid = process.env.REPOSITORY_UID || (await Bun.file(join(app.config.appDir, 'repository.uid')).text()).trim();
    const tokenFile = process.env.REST_TOKEN_FILE || join(app.config.appDir, 'rest-token');
    const token = (await Bun.file(tokenFile).text()).trim();
    if (token.length < 24) throw new Error('Use a random REST token of at least 24 characters');
    const audit = process.env.AUDIT_UPLOADS || '0';
    if (!['0', '1'].includes(audit)) throw new Error('AUDIT_UPLOADS must be 0 or 1');
    const store = new DriveStore(app.sdk, uid, audit === '1');
    app.onEvent(event => store.handleEvent(event));
    await store.open();
    await app.eventsManager.subscribeDriveScope((await app.sdk.getNode(uid)).treeEventScopeId);
    const spool = join(app.config.appDir, 'transfer');
    await rm(spool, { recursive: true, force: true });
    await mkdir(spool, { mode: 0o700 });
    const cache = new PackCache(join(app.config.appDir, 'verified-packs'), Number(process.env.PACK_CACHE_MIB || 256) * 1024 * 1024);
    await cache.open();
    const fetch = handler(store, token, spool, cache);
    const server = httpServer(fetch);
    const port = Number(process.env.PORT || 8000);
    server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Listening on http://127.0.0.1:${port}/`));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await app.dispose();
        process.exit(0);
    });
} catch (error) {
    console.error(error);
    await app.dispose();
    process.exit(1);
}
