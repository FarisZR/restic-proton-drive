import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DriveStore, name, size } from '../src/store';
import type { ProtonDriveClient, NodeEntity } from '@protontech/drive-sdk';

function node(uid: string, n: string, type = 'file', parentUid = 'root'): any {
    return { uid, parentUid, name: { ok: true, value: n }, type,
        activeRevision: type === 'file' ? { claimedSize: 5 } : undefined };
}
function fake() {
    const nodes = [node('root', 'repository', 'folder'), node('data', 'data', 'folder')];
    const calls: string[] = [];
    let failDelete = false;
    const sdk = {
        getNode: async (uid: string) => nodes.find(n => n.uid === uid),
        async *iterateNodes(ids: string[]) { for (const uid of ids) yield nodes.find(n => n.uid === uid) || { missingUid: uid }; },
        async *iterateFolderChildrenNodeUids(uid: string) { yield* nodes.filter(n => n.parentUid === uid && n.uid !== 'root' && !n.trashTime).map(n => n.uid); },
        async *trashNodes(ids: string[]) {
            for (const uid of ids) { calls.push(`trash:${uid}`); nodes.find(n => n.uid === uid).trashTime = new Date(); yield { uid, ok: true }; }
        },
        async *deleteNodes(ids: string[]) {
            for (const uid of ids) {
                if (failDelete) throw new Error('offline');
                calls.push(`delete:${uid}`); nodes.splice(nodes.findIndex(n => n.uid === uid), 1); yield { uid, ok: true };
            }
        },
        getFileUploader: async () => { throw new Error('upload failed before commit'); },
    };
    return { nodes, calls, sdk: sdk as unknown as ProtonDriveClient, fail: (v: boolean) => { failDelete = v; } };
}
test('degraded metadata and unknown lengths fail closed', () => {
    expect(() => name({ name: { ok: false } } as NodeEntity)).toThrow();
    expect(() => size({ type: 'file' } as NodeEntity)).toThrow();
});
test('duplicate listings fail; failed uploads never delete existing objects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
    try {
        const f = fake();
        const store = new DriveStore(f.sdk, 'root');
        await store.open();
        const path = join(dir, 'input'); await Bun.write(path, 'hello');
        const id = createHash('sha256').update('hello').digest('hex');
        await expect(store.put('data', id, path)).rejects.toThrow('upload failed');
        await expect(store.put('data', '0'.repeat(64), path)).rejects.toThrow('digest');
        expect(f.calls).toEqual([]);
        f.nodes.push(node('a', id, 'file', 'data'), node('b', id, 'file', 'data'));
        await expect(store.list('data')).rejects.toThrow('Duplicate');
    } finally { await rm(dir, { recursive: true, force: true }); }
});
test('trash-only removal is idempotent and leaves the object recoverable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
    try {
        const f = fake(); const id = 'a'.repeat(64);
        f.nodes.push(node('victim', id, 'file', 'data'), node('unrelated', 'personal', 'file', 'other'));
        const store = new DriveStore(f.sdk, 'root'); await store.open();
        await store.remove('data', id);
        expect(f.calls).toEqual(['trash:victim']);
        const recovered = new DriveStore(f.sdk, 'root'); await recovered.open();
        expect(f.nodes.find(n => n.uid === 'victim')?.trashTime).toBeDefined();
        expect(f.nodes.some(n => n.uid === 'unrelated')).toBe(true);
        await recovered.remove('data', id);
        expect(f.calls).toEqual(['trash:victim']);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
