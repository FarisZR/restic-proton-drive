import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DriveEventType, type DriveEvent } from '@protontech/drive-sdk';
import { Provider } from './support/provider';
import { DriveStore } from '../src/store';
import { PackCache } from '../src/pack-cache';
import { handler } from '../src/rest';
import { httpServer } from '../src/http';

const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const token = 'cache-performance-token-'.repeat(2);
const authorization = `Basic ${Buffer.from(`backup:${token}`).toString('base64')}`;
async function fixture(capacity = 256 * 1024) {
    const dir = await mkdtemp(join(tmpdir(), 'drive-index-cache-'));
    const provider = new Provider(join(dir, 'remote')); await provider.open();
    const store = new DriveStore(provider.sdk, 'root'); await store.open(); await store.create();
    const spool = join(dir, 'spool'); await mkdir(spool);
    const cache = new PackCache(join(dir, 'packs'), capacity); await cache.open();
    const server = httpServer(handler(store, token, spool, cache));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const request = (path: string, method = 'GET', body?: Uint8Array, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
        method, body: body as BodyInit | undefined, headers: { authorization, ...headers }, signal: AbortSignal.timeout(10000) });
    return { dir, provider, store, cache, request, close: async () => {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    } };
}

test('10,000-object lookup index scans once; complete listings remain authoritative', async () => {
    const f = await fixture();
    try {
        const parent = Object.values(f.provider.nodes).find(n => n.name.ok && n.name.value === 'data')!.uid;
        const template = f.provider.nodes.root;
        for (let n = 0; n < 10000; n++) {
            const id = n.toString(16).padStart(64, '0');
            f.provider.nodes['pack-' + n] = { ...template, uid: 'pack-' + n, parentUid: parent,
                type: 'file', name: { ok: true, value: id }, activeRevision: { uid: 'rev-' + n, claimedSize: 16 * 1024 * 1024 } } as any;
        }
        // A fresh store models a restart with no local object index.
        const store = new DriveStore(f.provider.sdk, 'root'); await store.open();
        const scans = f.provider.calls.scans;
        for (let n = 0; n < 1000; n++) {
            expect((await store.find('data', n.toString(16).padStart(64, '0')))?.uid).toBe('pack-' + n);
        }
        for (let n = 10000; n < 10100; n++) expect(await store.find('data', n.toString(16).padStart(64, '0'))).toBeUndefined();
        expect(f.provider.calls.scans - scans).toBe(1);
        f.provider.faults = { listing: 1 };
        await expect(store.list('data')).rejects.toThrow('listing');
        expect((await store.list('data')).length).toBe(10000);
    } finally { await f.close(); }
}, 15000);

test('Drive events update point lookups without a folder scan; refresh events rebuild', async () => {
    const f = await fixture();
    try {
        const body = new TextEncoder().encode('indexed pack'); const id = hash(body);
        expect((await f.request(`/data/${id}`, 'POST', body)).status).toBe(200);
        const node = (await f.store.find('data', id))!;
        const scans = f.provider.calls.scans;
        await f.store.handleEvent({ type: DriveEventType.NodeUpdated, nodeUid: node.uid, parentNodeUid: node.parentUid,
            isTrashed: false, isShared: false, treeEventScopeId: 'test', eventId: '1' });
        expect((await f.store.find('data', id))?.uid).toBe(node.uid);
        expect(f.provider.calls.scans).toBe(scans);
        delete f.provider.nodes[node.uid];
        await f.store.handleEvent({ type: DriveEventType.NodeDeleted, nodeUid: node.uid, parentNodeUid: node.parentUid,
            treeEventScopeId: 'test', eventId: '2' });
        expect(await f.store.find('data', id)).toBeUndefined();
        await f.store.handleEvent({ type: DriveEventType.TreeRefresh, treeEventScopeId: 'test', eventId: '3' });
        expect(await f.store.find('data', id)).toBeUndefined();
        expect(f.provider.calls.scans).toBe(scans + 1);
    } finally { await f.close(); }
});

test('range cache shares one verified download, detects local corruption, and full reads bypass it', async () => {
    const f = await fixture();
    try {
        const body = new Uint8Array(128 * 1024).fill(137), id = hash(body);
        expect((await f.request(`/data/${id}`, 'POST', body)).status).toBe(200);
        const before = f.provider.calls.download || 0;
        f.provider.faults = { delay: 5 };
        const parts = await Promise.all(Array.from({ length: 4 }, (_, n) => f.request(`/data/${id}`, 'GET', undefined, { range: `bytes=${n}-${n}` })));
        for (const response of parts) { expect(response.status).toBe(206); expect(await response.bytes()).toEqual(body.slice(0, 1)); }
        expect(f.provider.calls.download - before).toBe(1);
        const cached = (await readdir(join(f.dir, 'packs')))[0];
        await Bun.write(join(f.dir, 'packs', cached), new Uint8Array(body.length));
        expect((await f.request(`/data/${id}`, 'GET', undefined, { range: 'bytes=0-0' })).status).toBe(500);
        expect((await f.request(`/data/${id}`, 'GET', undefined, { range: 'bytes=0-0' })).status).toBe(206);
        f.provider.faults = { corruptRead: 1 };
        expect((await f.request(`/data/${id}`)).status).toBe(500); // remote full check cannot be masked by cache
        f.provider.faults = { corruptRead: 1 };
        expect((await f.request(`/data/${id}`, 'GET', undefined, { range: `bytes=0-${body.length - 1}` })).status).toBe(500);
    } finally { await f.close(); }
});

test('concurrent different packs and LRU eviction stay within capacity; slow writes do not block health or reads', async () => {
    const f = await fixture(2 * 65536);
    try {
        const bodies = [new Uint8Array(65536).fill(1), new Uint8Array(65536).fill(2), new Uint8Array(65536).fill(3)];
        for (const body of bodies) expect((await f.request(`/data/${hash(body)}`, 'POST', body)).status).toBe(200);
        for (const body of bodies) {
            const response = await f.request(`/data/${hash(body)}`, 'GET', undefined, { range: 'bytes=1-5' });
            expect(await response.bytes()).toEqual(body.slice(1, 6));
        }
        expect((await readdir(join(f.dir, 'packs'))).length).toBeLessThanOrEqual(2);
        f.provider.faults = { delay: 30 };
        const slowBody = new Uint8Array(256 * 1024).fill(4);
        const upload = f.request(`/data/${hash(slowBody)}`, 'POST', slowBody);
        await Bun.sleep(20);
        const started = Date.now();
        expect((await f.request('/health')).status).toBe(200);
        expect(Date.now() - started).toBeLessThan(200);
        const read = await f.request(`/data/${hash(bodies[2])}`, 'GET', undefined, { range: 'bytes=0-0' });
        expect(read.status).toBe(206); await read.bytes();
        expect((await upload).status).toBe(200);
    } finally { await f.close(); }
});

test('cache capacity counts pinned entries and canceled fills; one waiter can cancel without aborting another', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-cache-cancel-'));
    const body = new Uint8Array(65536).fill(19), id = hash(body);
    const cache = new PackCache(dir, body.length); await cache.open();
    let downloads = 0;
    const download = async (path: string, signal: AbortSignal) => {
        downloads++; await Bun.sleep(30); signal.throwIfAborted(); await Bun.write(path, body);
    };
    try {
        const first = new AbortController(), second = new AbortController();
        const abandoned = cache.acquire(id, body.length, download, first.signal);
        const retained = cache.acquire(id, body.length, download, second.signal);
        await Bun.sleep(5); first.abort(new Error('client disconnected'));
        await expect(abandoned).rejects.toThrow('client disconnected');
        const lease = (await retained)!;
        expect(downloads).toBe(1);
        expect(await Bun.file(lease.path).bytes()).toEqual(body);
        const other = new Uint8Array(65536).fill(20);
        await expect(cache.acquire(hash(other), other.length, async path => { await Bun.write(path, other); }, second.signal)).rejects.toThrow('busy');
        await lease.release();
        const otherLease = (await cache.acquire(hash(other), other.length, async path => { await Bun.write(path, other); }, second.signal))!;
        expect((await readdir(dir)).length).toBe(1);
        await otherLease.release();
        const last = new AbortController();
        const lastRequest = cache.acquire(id, body.length, download, last.signal);
        await Bun.sleep(5); last.abort(new Error('last waiter left'));
        await expect(lastRequest).rejects.toThrow('last waiter left');
        expect((await readdir(dir)).length).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent identical uploads publish once and leave a complete lookup index', async () => {
    const f = await fixture();
    try {
        const body = new Uint8Array(128 * 1024).fill(42), id = hash(body);
        const before = f.provider.calls.upload || 0;
        const responses = await Promise.all(Array.from({ length: 4 }, () => f.request(`/data/${id}`, 'POST', body)));
        expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200]);
        expect(f.provider.calls.upload - before).toBe(1);
        const listing = await f.request('/data/');
        expect(await listing.json()).toEqual([id]);
        expect(await (await f.request(`/data/${id}`)).bytes()).toEqual(body);
    } finally { await f.close(); }
});
