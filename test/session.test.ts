import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Credentials } from '../sdk/cli/src/credentials/credentials';
import { ApiClient } from 'proton-drive-sdk-account';
import { assertRequirements, FileSessionStore } from '../src/session';

test('SDK version/feature mismatch fails closed; compatible and suggested versions work', () => {
    for (const value of ['required=9.9.9', 'required=garbage', 'required='])
        expect(() => assertRequirements(new Headers({ 'x-pm-drive-platform-requirements': value }), '0.0.1')).toThrow();
    for (const value of ['drive=2', 'drive=1099511627776', 'drive=bad', 'drive=-1', 'drive='])
        expect(() => assertRequirements(new Headers({ 'x-pm-drive-requirements': value }))).toThrow();
    assertRequirements(new Headers({ 'x-pm-drive-platform-requirements': 'required=0.0.1 suggested=9.9.9',
        'x-pm-drive-requirements': 'drive=1 photos=2' }), '0.0.1');
});

test('session writes serialize, stay private, reload and reject malformed persistent state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-session-')); const path = join(dir, 'session');
    try {
        const store = new FileSessionStore(path);
        const snapshot = (n: number) => ({ userKeyPassword: 'key-password', session: { uid: 'uid', accessToken: `token${n}`, refreshToken: 'refresh' } });
        await Promise.all(Array.from({ length: 50 }, (_, n) => store.save(snapshot(n))));
        expect((await new FileSessionStore(path).load())?.session.accessToken).toBe('token49');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await Bun.write(path, '{"session":');
        await expect(store.load()).rejects.toThrow();
        await store.remove(); expect(await store.load()).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expired access token refreshes once under concurrent requests and persists new credentials', async () => {
    let refreshed = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        if (new URL(request.url).pathname === '/auth/v4/refresh') {
            refreshed++; return Response.json({ Code: 1000, UID: 'uid', AccessToken: 'new', RefreshToken: 'refresh-new' });
        }
        return request.headers.get('authorization') === 'Bearer new'
            ? Response.json({ Code: 1000 }) : Response.json({ Code: 401 }, { status: 401 });
    } });
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const dir = await mkdtemp(join(tmpdir(), 'drive-refresh-'));
    const path = join(dir, 'session');
    const credentials = new Credentials(new FileSessionStore(path), logger);
    await credentials.setSessionInfo({ uid: 'uid', accessToken: 'old', refreshToken: 'refresh' });
    await credentials.setUserKeyPassword('test-key-password');
    try {
        const client = new ApiClient({ baseUrl: String(server.url), appVersion: 'external-drive-test@0.1.0', credentials, logger });
        const responses = await Promise.all(Array.from({ length: 12 }, () => client.authenticatedRequest(String(server.url))));
        expect(responses.every(r => r.ok)).toBe(true);
        expect(refreshed).toBe(1); expect(credentials.refreshToken).toBe('refresh-new');
        expect((await new FileSessionStore(path).load())?.session.accessToken).toBe('new');
        expect((await new FileSessionStore(path).load())?.session.refreshToken).toBe('refresh-new');
    } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});


test('session persistence failure preserves the previous on-disk credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-store-failure-')); const path = join(dir, 'session');
    const store = new FileSessionStore(path);
    try {
        await store.save({ userKeyPassword: 'key', session: { uid: 'uid', accessToken: 'old' } });
        await chmod(dir, 0o500);
        await expect(store.save({ userKeyPassword: 'key', session: { uid: 'uid', accessToken: 'new' } })).rejects.toThrow();
        expect((await store.load())?.session.accessToken).toBe('old');
        await chmod(dir, 0o700);
        await store.save({ userKeyPassword: 'key', session: { uid: 'uid', accessToken: 'new' } });
        expect((await store.load())?.session.accessToken).toBe('new');
    } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});
