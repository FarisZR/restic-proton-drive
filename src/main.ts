import { httpServer } from './http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '../sdk/cli/src/init';
import { readPasswordLine } from '../sdk/cli/src/cli/readPasswordLine';
import { DriveStore } from './store';
import { handler } from './rest';

process.umask(0o077);
const command = process.argv[2];
if (!['login', 'create', 'serve'].includes(command)) {
    console.log('Usage: bun start login [username] | create <folder-name> | serve\nConfigure PROTON_DRIVE_CACHE_DIR, REPOSITORY_UID, REST_TOKEN_FILE, PORT (default 8000).');
    process.exit(1);
}
const app = await init({
    appVersion: 'external-drive-restic_backup@0.1.0-alpha',
    clientUidPrefix: 'restic-backup', enablePersistedEvents: true,
});
try {
    if (!app.eventsProvider.canListenForEvents()) throw new Error('Another process is using this session directory');
    if (command === 'login') {
        console.log('This is a third-party application not officially supported by Proton.');
        const username = process.argv[3];
        if (username) {
            const password = await readPasswordLine('Password: ');
            await app.auth.authViaPassword(username, password);
        } else {
            await app.auth.authViaWeb(url => { console.log(url); });
        }
        console.log('Signed in.');
        await app.dispose();
        process.exit(0);
    }
    if (!app.auth.isLoggedIn()) throw new Error('Run login first');
    if (command === 'create') {
        const folderName = process.argv[3];
        if (!folderName || /[\\/]/.test(folderName)) throw new Error('Provide a single folder name');
        const root = await app.sdk.getMyFilesRootFolder();
        const folder = await app.sdk.createFolder(root.uid, folderName);
        console.log(`REPOSITORY_UID=${folder.uid}`);
        await app.dispose();
        process.exit(0);
    }
    const uid = process.env.REPOSITORY_UID;
    const tokenFile = process.env.REST_TOKEN_FILE;
    if (!uid || !tokenFile) throw new Error('REPOSITORY_UID and REST_TOKEN_FILE are required');
    const token = (await Bun.file(tokenFile).text()).trim();
    if (token.length < 24) throw new Error('Use a random REST token of at least 24 characters');
    const store = new DriveStore(app.sdk, uid, app.config.appDir);
    await store.open();
    await app.eventsManager.subscribeDriveScope((await app.sdk.getNode(uid)).treeEventScopeId);
    const spool = join(app.config.appDir, 'transfer');
    await rm(spool, { recursive: true, force: true });
    await mkdir(spool, { mode: 0o700 });
    const fetch = handler(store, token, spool);
    const server = httpServer(fetch);
    const port = Number(process.env.PORT || 8000);
    server.listen(port, '127.0.0.1', () => console.log(`Listening on http://127.0.0.1:${port}/`));
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
