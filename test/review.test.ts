import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Provider } from './support/provider';
import { DriveStore } from '../src/store';
import { handler } from '../src/rest';
import { httpServer } from '../src/http';
import { DurableCredentials, SessionApiClient } from '../src/credentials';
import { FileSessionStore } from '../src/session';
import { RequestHTTPClient, SerialQueue, withSignal } from '../src/request-context';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const token = 'review-token-'.repeat(4);
const authorization = `Basic ${Buffer.from(`backup:${token}`).toString('base64')}`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(timeout = 10000) {
    const dir = await mkdtemp(join(tmpdir(), 'review-fault-'));
    const provider = new Provider(join(dir, 'remote')); await provider.open();
    const store = new DriveStore(provider.sdk, 'root'); await store.open(); await store.create();
    const spool = join(dir, 'spool'); await mkdir(spool);
    const server = httpServer(handler(store, token, spool), timeout);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const request = (path: string, method = 'GET', body?: Uint8Array, signal = AbortSignal.timeout(5000)) => fetch(`http://127.0.0.1:${port}${path}`, {
        method, body: body as BodyInit | undefined, headers: { authorization }, signal });
    return { dir, provider, store, request, close: async () => {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
    } };
}

test('normal commit acknowledgment downloads zero bytes; lock mutations bypass five stalled uploads', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>(); let started = 0;
    const original = f.provider.getFileUploader.bind(f.provider);
    f.provider.getFileUploader = async (...args) => {
        const uploader = await original(...args);
        return { uploadFromStream: async stream => {
            const controller = await uploader.uploadFromStream(stream);
            return { completion: async () => {
                const parent = args[0]; const folder = f.provider.nodes[parent];
                if (folder.name.ok && folder.name.value === 'data') { started++; await gate.promise; }
                return controller.completion();
            } };
        } };
    };
    try {
        const body = new Uint8Array(1024).fill(7);
        const uploads = Array.from({ length: 5 }, (_, n) => { const b = body.slice(); b[0] = n; return f.request(`/data/${hash(b)}`, 'POST', b); });
        while (!started) await Bun.sleep(1);
        const lock = new TextEncoder().encode('refreshed lock'), id = hash(lock);
        for (let n = 0; n < 8; n++) {
            expect((await f.request(`/locks/${id}`, 'POST', lock)).status).toBe(200);
            expect((await f.request('/locks/')).status).toBe(200);
            expect((await f.request(`/locks/${id}`, 'DELETE')).status).toBe(200);
        }
        expect((await f.request('/health')).status).toBe(200);
        gate.resolve();
        for (const response of await Promise.all(uploads)) expect(response.status).toBe(200);
        expect(f.provider.calls.download || 0).toBe(0);
        expect(f.provider.calls.permanent || 0).toBe(0);
    } finally { gate.resolve(); await f.close(); }
});

test('HTTP deadlines cancel metadata transport and release admission only after work stops', async () => {
    const f = await fixture(100);
    let active = 0, aborted = 0, block = true;
    const original = f.provider.iterateFolderChildrenNodeUids.bind(f.provider);
    f.provider.iterateFolderChildrenNodeUids = async function* (parent, options, signal) {
        if (block) {
            active++;
            try {
                await new Promise<void>((_resolve, reject) => {
                    signal!.addEventListener('abort', () => { aborted++; reject(signal!.reason); }, { once: true });
                    if (signal!.aborted) { aborted++; reject(signal!.reason); }
                });
            } finally { active--; }
        }
        yield* original(parent, options, signal);
    };
    try {
        await Promise.all(Array.from({ length: 5 }, () => f.request('/data/').catch(() => undefined)));
        expect(aborted).toBe(5); expect(active).toBe(0);
        block = false;
        expect((await f.request('/data/')).status).toBe(200);
    } finally { await f.close(); }
});

test('transport injects cancellation into SDK metadata calls without a signal parameter', async () => {
    let observed: AbortSignal | undefined;
    const transport = new RequestHTTPClient({ authenticatedRequest: async (_url: string, options: { signal?: AbortSignal }) => {
        observed = options.signal;
        return new Promise<Response>((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    } } as any);
    const controller = new AbortController();
    const pending = withSignal(controller.signal, () => transport.fetchJson({ url: 'https://drive-api.proton.me/test', method: 'GET', headers: new Headers(), timeoutMs: 1000 }));
    controller.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');
    expect(observed?.aborted).toBe(true);
});

test('canceled queued mutations never execute or overtake an active mutation', async () => {
    const queue = new SerialQueue(), gate = Promise.withResolvers<void>(); const order: number[] = [];
    const first = queue.run(undefined, async () => { order.push(1); await gate.promise; });
    const cancel = new AbortController();
    const second = queue.run(cancel.signal, async () => { order.push(2); });
    const third = queue.run(undefined, async () => { order.push(3); });
    cancel.abort(new Error('canceled')); await expect(second).rejects.toThrow('canceled');
    expect(order).toEqual([1]); gate.resolve(); await first; await third; expect(order).toEqual([1, 3]);
});

test('failed refresh-token save is retried before the SDK shortcut; restart loads the rotated token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'refresh-save-failure-')), key = Buffer.alloc(32, 9);
    const file = new FileSessionStore(join(dir, 'session'), key); let failed = false, saves = 0, refreshes = 0;
    const failingLogger = { ...logger, error() { throw new Error('log disk unavailable'); } };
    const credentials = new DurableCredentials({ load: () => file.load(), remove: () => file.remove(), save: async snapshot => {
        saves++; if (failed) throw new Error('disk unavailable'); await file.save(snapshot);
    } }, failingLogger);
    await credentials.setSessionInfo({ uid: 'uid', accessToken: 'old', refreshToken: 'refresh-old' });
    await credentials.setUserKeyPassword('key-password');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        if (new URL(request.url).pathname.endsWith('/auth/v4/refresh')) {
            refreshes++; return Response.json({ UID: 'uid', AccessToken: 'new', RefreshToken: 'refresh-new' });
        }
        return Response.json({ ok: true });
    } });
    try {
        const client = new SessionApiClient({ baseUrl: String(server.url).replace(/\/$/, ''), appVersion: 'external-drive-test@0.2.0', credentials, logger });
        failed = true;
        await expect(client.refreshSessionIfPossible('old')).rejects.toThrow('disk unavailable');
        expect(credentials.accessToken).toBe('new'); expect((await file.load())?.session.accessToken).toBe('old');
        const before = saves;
        await expect(client.refreshSessionIfPossible('old')).rejects.toThrow('disk unavailable');
        expect(saves).toBeGreaterThan(before);
        failed = false;
        expect(await client.refreshSessionIfPossible('old')).toBe(true);
        expect(refreshes).toBe(1);
        const restarted = new DurableCredentials(file, logger); await restarted.load();
        expect(restarted.accessToken).toBe('new'); expect(restarted.refreshToken).toBe('refresh-new');
        await restarted.close();
    } finally { failed = false; await credentials.close(); server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
