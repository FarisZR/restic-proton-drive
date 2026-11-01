import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { Provider } from './support/provider';
import { DriveStore } from '../src/store';
import { handler } from '../src/rest';
import { httpServer } from '../src/http';

const token = 'test-token-'.repeat(4);
const authorization = `Basic ${Buffer.from(`backup:${token}`).toString('base64')}`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(timeoutMs?: number) {
    const dir = await mkdtemp(join(tmpdir(), 'drive-faults-'));
    const provider = new Provider(join(dir, 'remote')); await provider.open();
    const store = new DriveStore(provider.sdk, 'root', dir); await store.open(); await store.create();
    const spool = join(dir, 'spool'); await mkdir(spool);
    const server = httpServer(handler(store, token, spool), timeoutMs);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const request = (path: string, method = 'GET', body?: Uint8Array, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
        method, body: body as BodyInit | undefined, headers: { authorization, ...headers }, signal: AbortSignal.timeout(5000) });
    return { provider, store, request, dir, port, close: async () => {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    } };
}

test('SDK fault matrix: failed reads/listings never return successful partial data', async () => {
    const f = await fixture();
    try {
        const body = crypto.getRandomValues(new Uint8Array(65536)); const id = hash(body);
        expect((await f.request(`/data/${id}`, 'POST', body)).status).toBe(200);
        for (const fault of ['download', 'corruptRead', 'truncateRead', 'signature'] as const) {
            f.provider.faults = { [fault]: 1 };
            const response = await f.request(`/data/${id}`);
            expect(response.status).toBe(500); expect((await response.bytes()).length).toBeLessThan(body.length);
            expect(await (await f.request(`/data/${id}`)).bytes()).toEqual(body);
        }
        for (const fault of ['listing', 'listingEntry'] as const) {
            f.provider.faults = { [fault]: 1 };
            expect((await f.request('/data/')).status).toBe(500);
        }
        expect((await f.request('/data/', 'GET', undefined, { accept: 'application/vnd.x.restic.rest.v3' })).status).toBe(406);
        expect((await f.request(`/data/${id}`, 'GET', undefined, { range: 'bytes=65536-' })).status).toBe(416);
        expect((await f.request('/health')).status).toBe(200);
    } finally { await f.close(); }
});

test('upload failures, lost acknowledgments, read-back corruption and immutable config', async () => {
    const f = await fixture();
    try {
        const bytes = new TextEncoder().encode('unique payload'); const id = hash(bytes);
        f.provider.faults = { upload: 1 };
        expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(500);
        expect((await f.request(`/data/${id}`, 'HEAD')).status).toBe(404);
        f.provider.faults = { lostAck: 1 };
        expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(500);
        expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(200);
        expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(200);
        expect(await (await f.request(`/data/${id}`)).bytes()).toEqual(bytes);
        const corrupted = new TextEncoder().encode('server lied about commit');
        f.provider.faults = { corruptUpload: 1 };
        expect((await f.request(`/data/${hash(corrupted)}`, 'POST', corrupted)).status).toBe(500);
        expect((await f.request(`/data/${hash(corrupted)}`)).status).toBe(500);
        expect((await f.request('/config', 'POST', bytes)).status).toBe(200);
        expect((await f.request('/config', 'POST', bytes)).status).toBe(200);
        expect((await f.request('/config', 'POST', corrupted)).status).toBe(409);
        expect(await (await f.request('/config')).bytes()).toEqual(bytes);
    } finally { await f.close(); }
});

test('slow/truncated uploads, oversize declarations and connection loss release the operation gate', async () => {
    const f = await fixture();
    try {
        const bytes = new TextEncoder().encode('slow but complete'); const id = hash(bytes);
        // A real TCP sender avoids fetch repairing an invalid Content-Length.
        async function send(length: number, complete: boolean) {
            await new Promise<void>((resolve, reject) => {
                const socket = connect(f.port, '127.0.0.1', () => {
                    socket.write(`POST /data/${id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${authorization}\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`);
                    socket.write(bytes.subarray(0, 4));
                    setTimeout(() => { if (complete) socket.write(bytes.subarray(4)); else socket.destroy(); }, 30);
                });
                socket.on('data', () => {}); socket.on('close', () => resolve()); socket.on('error', reject);
            });
        }
        await send(bytes.length + 10, false);
        expect((await f.request(`/data/${id}`, 'HEAD')).status).toBe(404);
        await send(bytes.length, true);
        expect(await (await f.request(`/data/${id}`)).bytes()).toEqual(bytes);
        // Cancel after headers while a large response is still flowing.
        const big = new Uint8Array(4 * 1024 * 1024); const bigId = hash(big);
        expect((await f.request(`/data/${bigId}`, 'POST', big)).status).toBe(200);
        const response = await f.request(`/data/${bigId}`); await response.body!.cancel();
        expect((await f.request('/health')).status).toBe(200);
    } finally { await f.close(); }
});

test('queue saturation recovers after stalled clients disconnect', async () => {
    const f = await fixture();
    const sockets: ReturnType<typeof connect>[] = [];
    try {
        for (let i = 0; i < 8; i++) {
            const socket = connect(f.port, '127.0.0.1'); sockets.push(socket);
            socket.on('error', () => {});
            await new Promise<void>(resolve => socket.once('connect', resolve));
            socket.write(`POST /data/${'0'.repeat(64)} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${authorization}\r\nContent-Length: 100\r\n\r\nx`);
        }
        await Bun.sleep(50);
        expect((await f.request('/health')).status).toBe(503);
        sockets.forEach(s => s.destroy());
        await Bun.sleep(50);
        expect((await f.request('/health')).status).toBe(200);
        // Disk unavailable: fail the write, then continue with a healthy spool.
        await rm(join(f.dir, 'spool'), { recursive: true });
        expect((await f.request(`/data/${'0'.repeat(64)}`, 'POST', new Uint8Array())).status).toBe(500);
        await mkdir(join(f.dir, 'spool'));
        expect((await f.request('/health')).status).toBe(200);
    } finally { sockets.forEach(s => s.destroy()); await f.close(); }
});


test('empty objects and zero-length ranges; deadline aborts a stalled upload', async () => {
    const f = await fixture(250);
    try {
        const bytes = new Uint8Array(); const id = hash(bytes);
        expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(200);
        const response = await f.request(`/data/${id}`);
        expect(response.headers.get('content-length')).toBe('0');
        expect((await response.bytes()).length).toBe(0);
        const invalid = await f.request(`/data/${id}`, 'GET', undefined, { range: 'bytes=0-' });
        expect(invalid.status).toBe(416);
        expect(invalid.headers.get('content-length')).toBe('0');
        expect((await invalid.bytes()).length).toBe(0);
        await new Promise<void>((resolve, reject) => {
            const socket = connect(f.port, '127.0.0.1', () => socket.write(`POST /data/${id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${authorization}\r\nContent-Length: 100\r\n\r\nx`));
            socket.on('data', () => {}); socket.on('error', reject); socket.on('close', () => resolve());
        });
        expect((await f.request('/health')).status).toBe(200);
    } finally { await f.close(); }
});

test('deletion restart matrix preserves unrelated objects across every ambiguous outcome', async () => {
    for (const fault of ['trash', 'permanent', 'deleteAck'] as const) {
        const f = await fixture();
        try {
            const bytes = new TextEncoder().encode(`delete-${fault}`); const id = hash(bytes);
            expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(200);
            const unrelated = await f.provider.createFolder('elsewhere', 'personal');
            f.provider.faults = { [fault]: 1 };
            expect((await f.request(`/data/${id}`, 'DELETE')).status).toBe(500);
            // New provider and store, with only on-disk state preserved.
            const reloaded = new Provider(join(f.dir, 'remote')); await reloaded.open();
            const store = new DriveStore(reloaded.sdk, 'root', f.dir); await store.open();
            expect(await store.find('data', id)).toBeUndefined();
            expect((await reloaded.getNode(unrelated.uid)).name).toEqual({ ok: true, value: 'personal' });
            await store.remove('data', id); // lost HTTP deletion acknowledgment retry
        } finally { await f.close(); }
    }
});

test('repeated mixed writes/ranges/removes remain byte-exact with transient failures', async () => {
    const f = await fixture();
    try {
        for (let n = 0; n < 64; n++) {
            const bytes = new Uint8Array(2048 + n); bytes.fill(n); const id = hash(bytes);
            if (n % 8 === 0) {
                f.provider.faults = { lostAck: 1 };
                expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(500);
            }
            expect((await f.request(`/data/${id}`, 'POST', bytes)).status).toBe(200);
            const start = n * 3, end = start + 100;
            const response = await f.request(`/data/${id}`, 'GET', undefined, { range: `bytes=${start}-${end}` });
            expect(response.status).toBe(206);
            expect(await response.bytes()).toEqual(bytes.subarray(start, end + 1));
            expect((await f.request(`/data/${id}`, 'DELETE')).status).toBe(200);
            expect((await f.request(`/data/${id}`, 'HEAD')).status).toBe(404);
        }
        const listing = await f.request('/data/', 'GET', undefined, { accept: 'application/vnd.x.restic.rest.v2' });
        expect(await listing.json()).toEqual([]);
    } finally { await f.close(); }
}, 30000);
