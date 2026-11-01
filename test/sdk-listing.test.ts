import { expect, test } from 'bun:test';
import { ProtonDriveClient } from '@protontech/drive-sdk';
import { NodesAccess } from '../sdk/client/js/src/internal/nodes/nodesAccess';
import { DriveStore } from '../src/store';

// Real pinned SDK traversal/metadata code, with an inconsistent API response.
// Crypto is stubbed; the failure is injected below the SDK at metadata loading.
test.each(['data', 'snapshots', 'locks'])('actual SDK metadata omission fails %s listing and lookup', async type => {
    const root = 'vol~root', data = 'vol~data', first = 'vol~first', missing = 'vol~missing';
    const make = (uid: string, parentUid: string | undefined, name: string, type: string) => ({ uid, parentUid,
        name: { ok: true, value: name }, type, isStale: false,
        activeRevision: type === 'file' ? { uid: uid + '~rev', claimedSize: 5 } : undefined });
    const nodes = new Map([[root, make(root, undefined, 'repo', 'folder')], [data, make(data, root, type, 'folder')],
        [first, make(first, data, 'a'.repeat(64), 'file')]]);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const api = {
        async *iterateChildrenNodeUids(parent: string) { yield* parent === root ? [data] : [first, missing]; },
        async *iterateNodes(ids: string[]) { for (const uid of ids) if (nodes.has(uid)) yield { uid }; },
    };
    const cache = {
        async getNode(uid: string) { if (uid === root || uid === data) return nodes.get(uid); throw new Error('cache miss'); },
        async *iterateNodes(ids: string[]) { for (const uid of ids) yield uid === data ? { ok: true, node: nodes.get(uid) } : { ok: false, uid }; },
        async removeNodes() {},
    };
    const access = new NodesAccess({ getLogger: () => logger } as any, api as any, cache as any, {} as any, {} as any,
        { getRootIDs: async () => ({ volumeId: 'vol' }) } as any);
    (access as any).decryptNode = async ({ uid }: { uid: string }) => {
        (access as any).debouncer.finishedLoadingNode(uid);
        return { node: nodes.get(uid) };
    };
    const sdk: ProtonDriveClient = Object.assign(Object.create(ProtonDriveClient.prototype), { logger, nodes: { access } });
    expect((await Array.fromAsync(sdk.iterateFolderChildren(data))).length).toBe(1); // reproduces review finding
    const store = new DriveStore(sdk, root); await store.open();
    await expect(store.list(type)).rejects.toThrow('Missing metadata');
    await expect(store.find(type, 'f'.repeat(64))).rejects.toThrow('Missing metadata');
});

test('aborted SDK metadata enumeration drains outstanding decrypt work before completing', async () => {
    const root = 'vol~root', data = 'vol~data';
    const make = (uid: string, parentUid?: string) => ({ uid, parentUid, name: { ok: true, value: uid === root ? 'repo' : uid === data ? 'data' : uid.endsWith('1') ? 'a'.repeat(64) : 'b'.repeat(64) },
        type: uid === root || uid === data ? 'folder' : 'file', isStale: false, activeRevision: uid.includes('pack') ? { uid: uid + '~rev', claimedSize: 5 } : undefined });
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let active = 0;
    const cache = {
        async getNode(uid: string) { if (uid === root || uid === data) return make(uid, uid === data ? root : undefined); throw new Error('miss'); },
        async *iterateNodes(ids: string[]) { for (const uid of ids) yield uid === data ? { ok: true, node: make(data, root) } : { ok: false, uid }; },
        async removeNodes() {},
    };
    const access = new NodesAccess({ getLogger: () => logger } as any, {
        async *iterateChildrenNodeUids(uid: string) { yield* uid === root ? [data] : ['vol~pack1', 'vol~pack2']; },
        async *iterateNodes(ids: string[]) { for (const uid of ids) yield { uid }; },
    } as any, cache as any, {} as any, {} as any, { getRootIDs: async () => ({ volumeId: 'vol' }) } as any);
    (access as any).decryptNode = async ({ uid }: { uid: string }) => {
        if (uid.endsWith('2')) { active++; started.resolve(); await gate.promise; active--; }
        (access as any).debouncer.finishedLoadingNode(uid);
        return { node: make(uid, data) };
    };
    const sdk: ProtonDriveClient = Object.assign(Object.create(ProtonDriveClient.prototype), { logger, nodes: { access } });
    const store = new DriveStore(sdk, root); await store.open();
    const controller = new AbortController(); let settled = false;
    const pending = store.list('data', controller.signal);
    void pending.catch(() => {}).finally(() => { settled = true; });
    await started.promise; controller.abort(new Error('canceled'));
    await Bun.sleep(10); expect(settled).toBe(false); expect(active).toBe(1);
    gate.resolve(); await expect(pending).rejects.toThrow('canceled'); expect(active).toBe(0);
});
