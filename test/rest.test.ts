import { expect, test } from 'bun:test';
import { handler, range } from '../src/rest';
import { createHash } from 'node:crypto';
import type { DriveStore } from '../src/store';

const token = 'a'.repeat(32);
const auth = { authorization: `Basic ${Buffer.from(`backup:${token}`).toString('base64')}` };
const id = createHash('sha256').update('hello').digest('hex');
const node = { activeRevision: { claimedSize: 5 }, type: 'file' };
function fixture() {
    const store = {
        list: async () => [{ name: id, size: 5 }],
        find: async () => node,
        read: async (_: unknown, path: string) => { await Bun.write(path, 'hello'); },
        put: async () => {}, create: async () => {}, remove: async () => {},
    };
    return { store, fetch: handler(store as unknown as DriveStore, token) };
}
function req(path: string, options: RequestInit = {}) {
    return new Request(`http://localhost${path}`, { ...options, headers: { ...auth, ...options.headers } });
}
test('range validation', () => {
    expect(range('bytes=1-3', 5)).toEqual([1, 3]);
    expect(range('bytes=-2', 5)).toEqual([3, 4]);
    expect(range('bytes=3-', 5)).toEqual([3, 4]);
    for (const r of ['bytes=5-', 'bytes=-0', 'bytes=2-1', 'bytes=0-1,3-4', 'invalid'])
        expect(() => range(r, 5)).toThrow();
});
test('authentication, strict paths, API versions and gate release', async () => {
    const { fetch } = fixture();
    expect((await fetch(new Request('http://localhost/config'))).status).toBe(401);
    expect((await fetch(req('/data/not-an-id'))).status).toBe(404);
    expect(await (await fetch(req('/data/'))).json()).toEqual([id]);
    const v2 = await fetch(req('/data/', { headers: { accept: 'application/vnd.x.restic.rest.v2' } }));
    expect(await v2.json()).toEqual([{ name: id, size: 5 }]);
    expect(v2.headers.get('content-type')).toBe('application/vnd.x.restic.rest.v2');
    expect((await fetch(req('/', { method: 'DELETE' }))).status).toBe(403);
});
test('verified full and partial reads; missing and invalid ranges', async () => {
    const { fetch } = fixture();
    const full = await fetch(req(`/data/${id}`));
    expect(await full.text()).toBe('hello');
    const partial = await fetch(req(`/data/${id}`, { headers: { range: 'bytes=1-3' } }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 1-3/5');
    expect(await partial.text()).toBe('ell');
    expect((await fetch(req(`/data/${id}`, { headers: { range: 'bytes=5-' } }))).status).toBe(416);
    expect((await fetch(req(`/data/${id}`, { method: 'HEAD' }))).headers.get('content-length')).toBe('5');
});
test('storage failures never become successful listings or reads', async () => {
    const { store, fetch } = fixture();
    store.list = async () => { throw new Error('page failed'); };
    expect((await fetch(req('/data/'))).status).toBe(500);
    store.read = async () => { throw new Error('signature failed'); };
    expect((await fetch(req(`/data/${id}`))).status).toBe(500);
});

test('HTTP transport preserves exact Content-Length for restic 0.19.1 range reads', async () => {
    const { httpServer } = await import('../src/http');
    const server = httpServer(fixture().fetch);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/data/${id}`, {
            headers: { ...auth, range: 'bytes=1-3' },
        });
        expect(response.status).toBe(206);
        expect(response.headers.get('content-length')).toBe('3');
        expect(response.headers.get('transfer-encoding')).toBeNull();
        expect(await response.text()).toBe('ell');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
