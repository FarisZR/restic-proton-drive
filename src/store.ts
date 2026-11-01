import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { SerialQueue, withSignal } from './request-context';
import { DriveEventType, type DriveEvent, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';

export const types = ['data', 'index', 'keys', 'locks', 'snapshots'];
export const MAX = 64 * 1024 * 1024;
export class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export function name(node: NodeEntity): string {
    if (!node.name.ok || node.errors?.length) throw new Error('Unreadable Drive metadata');
    for (const author of [node.keyAuthor, node.nameAuthor, node.activeRevision?.contentAuthor]) {
        if (author && !author.ok) throw new Error('Invalid Drive authorship');
    }
    return node.name.value;
}
export function size(node: NodeEntity): number {
    const n = node.activeRevision?.claimedSize;
    if (node.type !== NodeType.File || !Number.isSafeInteger(n) || n! < 0 || n! > MAX)
        throw new Error('Invalid or unsupported object size');
    return n!;
}
export async function digest(file: Blob, algorithm: string, signal?: AbortSignal) {
    const hash = createHash(algorithm);
    for await (const chunk of file.stream()) { signal?.throwIfAborted(); hash.update(chunk); }
    return hash.digest('hex');
}

// One dedicated repository folder, accessed by one adapter process.
export class DriveStore {
    private folders = new Map<string, string>();
    private indexes = new Map<string, Map<string, NodeEntity>>();
    private reverse = new Map<string, string>();
    private generation = 0;
    private mutations = new SerialQueue();
    private lockMutations = new SerialQueue();
    private eventQueue: Promise<void> = Promise.resolve();
    private exclusive<T>(type: string, signal: AbortSignal | undefined, action: () => Promise<T>) {
        return (type === 'locks' ? this.lockMutations : this.mutations).run(signal, action);
    }
    private invalidate(uid?: string) {
        this.generation++;
        if (uid) {
            for (const node of this.indexes.get(uid)?.values() || []) this.reverse.delete(node.uid);
            this.indexes.delete(uid);
        } else { this.indexes.clear(); this.reverse.clear(); }
    }
    private remember(parent: string, node: NodeEntity) {
        this.generation++;
        const n = name(node);
        const index = this.indexes.get(parent);
        if (index) {
            const conflict = index.get(n);
            if (conflict && conflict.uid !== node.uid) { this.invalidate(parent); throw new Error('Duplicate Drive name'); }
            const old = this.reverse.get(node.uid);
            if (old && old !== n) index.delete(old);
            index.set(n, node);
        }
        this.reverse.set(node.uid, n);
    }
    // SDK listeners must never throw. Invalidate on errors, then rebuild on demand.
    handleEvent(event: DriveEvent): Promise<void> {
        if (event.type === DriveEventType.FastForward || event.type === DriveEventType.SharedWithMeUpdated) return Promise.resolve();
        this.generation++;
        this.eventQueue = this.eventQueue.then(async () => {
            if (![DriveEventType.NodeCreated, DriveEventType.NodeUpdated, DriveEventType.NodeDeleted].includes(event.type)) {
                this.invalidate(); return;
            }
            if (!('nodeUid' in event)) return;
            const erase = () => {
                const old = this.reverse.get(event.nodeUid);
                for (const index of this.indexes.values()) if (old && index.get(old)?.uid === event.nodeUid) index.delete(old);
                this.reverse.delete(event.nodeUid);
            };
            if (event.type === DriveEventType.NodeDeleted || ('isTrashed' in event && event.isTrashed)) { erase(); return; }
            const node = await this.sdk.getNode(event.nodeUid);
            name(node);
            if (node.type === NodeType.File && !node.activeRevision) return;
            if (node.parentUid === this.root || [...this.folders.values()].includes(node.parentUid || '')) {
                erase(); this.remember(node.parentUid!, node);
            } else if (this.reverse.has(node.uid)) { erase(); this.invalidate(); }
        }).catch(() => { this.invalidate(); });
        return this.eventQueue;
    }
    private async indexed(parent: string, fresh = false, signal?: AbortSignal): Promise<Map<string, NodeEntity>> {
        signal?.throwIfAborted();
        if (!fresh && this.indexes.has(parent)) return this.indexes.get(parent)!;
        for (let attempt = 0; attempt < 4; attempt++) {
            const generation = this.generation;
            const nodes = await this.children(parent, signal);
            signal?.throwIfAborted();
            if (generation !== this.generation) continue;
            const index = new Map(nodes.map(node => [name(node), node]));
            for (const node of this.indexes.get(parent)?.values() || []) this.reverse.delete(node.uid);
            this.indexes.set(parent, index);
            for (const node of nodes) this.reverse.set(node.uid, name(node));
            return index;
        }
        throw new HttpError(503, 'Repository changed during listing; retry');
    }
    constructor(private sdk: ProtonDriveClient, private root: string, private auditUploads = false) {}
    private async node(uid: string, signal?: AbortSignal) {
        const nodes = await this.metadata([uid], signal);
        return nodes[0];
    }
    private metadata(ids: string[], signal?: AbortSignal) {
        return withSignal(signal, () => this.metadataInternal(ids, signal));
    }
    private async metadataInternal(ids: string[], signal?: AbortSignal) {
        const expected = new Set(ids);
        const nodes: NodeEntity[] = [];
        let failure: Error | undefined;
        // The pinned SDK's signaled mapper can abandon in-flight decrypt jobs.
        // Cancel its HTTP transport via context, but drain the mapper before
        // releasing admission. Do not close this iterator on the first bad item.
        for await (const result of this.sdk.iterateNodes(ids)) {
            if (signal?.aborted) continue;
            if ('missingUid' in result) { failure ||= new Error(`Missing metadata for enumerated node ${result.missingUid}`); continue; }
            if (!expected.delete(result.uid)) { failure ||= new Error('Unexpected or duplicate metadata result'); continue; }
            try { name(result); nodes.push(result); }
            catch (error) { failure ||= error as Error; }
        }
        signal?.throwIfAborted();
        if (failure) throw failure;
        if (expected.size) throw new Error('Incomplete metadata response');
        return nodes;
    }
    async open() {
        const root = await this.sdk.getNode(this.root);
        name(root);
        if (root.type !== NodeType.Folder || root.trashTime) throw new Error('Repository must be an active folder');
        for (const node of (await this.indexed(this.root, true)).values()) {
            const n = name(node);
            if (types.includes(n)) {
                if (node.type !== NodeType.Folder) throw new Error('Invalid repository layout');
                this.folders.set(n, node.uid);
            } else if (n !== 'config') throw new Error('Use a dedicated repository folder');
        }
    }
    create(signal?: AbortSignal) { return this.exclusive('config', signal, () => this.createInternal(signal)); }
    private async createInternal(signal?: AbortSignal) {
        signal?.throwIfAborted();
        for (const type of types) if (!this.folders.has(type)) {
            const node = await this.sdk.createFolder(this.root, type);
            this.folders.set(type, node.uid);
            this.remember(this.root, node);
            this.indexes.set(node.uid, new Map());
        }
    }
    private parent(type: string) {
        if (type === 'config') return this.root;
        const uid = this.folders.get(type);
        if (!uid) throw new HttpError(503, 'Repository directory missing; initialize or repair the layout');
        return uid;
    }
    private children(uid: string, signal?: AbortSignal) {
        return withSignal(signal, () => this.childrenInternal(uid, signal));
    }
    private async childrenInternal(uid: string, signal?: AbortSignal) {
        const result: NodeEntity[] = [];
        const names = new Set<string>();
        const ids = new Set<string>();
        let batch: string[] = [];
        const load = async () => {
            for (const node of await this.metadata(batch, signal)) {
                if (node.parentUid !== uid || node.trashTime) throw new Error('Directory changed during listing');
                const n = name(node);
                if (names.has(n)) throw new Error('Duplicate Drive name');
                names.add(n); result.push(node);
            }
            batch = [];
        };
        // The convenience iterateFolderChildren() drops missingUid results.
        // Enumerate IDs ourselves, then require exactly one metadata result per ID.
        for await (const id of this.sdk.iterateFolderChildrenNodeUids(uid, undefined, signal)) {
            signal?.throwIfAborted();
            if (ids.has(id)) throw new Error('Duplicate child ID');
            ids.add(id); batch.push(id);
            if (batch.length === 30) await load();
        }
        if (batch.length) await load();
        signal?.throwIfAborted();
        return result;
    }
    async list(type: string, signal?: AbortSignal) {
        return [...(await this.indexed(this.parent(type), true, signal)).values()].map(node => {
            const n = name(node);
            if (!/^[a-f0-9]{64}$/.test(n)) throw new Error('Unexpected repository entry');
            return { name: n, size: size(node) };
        });
    }
    async find(type: string, id: string, signal?: AbortSignal) {
        const parent = this.parent(type);
        const known = (await this.indexed(parent, false, signal)).get(id);
        if (!known) return;
        try {
            const node = await this.node(known.uid, signal);
            name(node);
            if (node.trashTime || node.parentUid !== parent) { this.invalidate(parent); throw new Error('Repository object moved or trashed'); }
            if (name(node) !== id) { this.invalidate(parent); throw new Error('Repository object renamed'); }
            return node;
        } catch (error) { this.invalidate(parent); throw error; }
    }
    read(node: NodeEntity, path: string, signal?: AbortSignal) {
        return withSignal(signal, () => this.readInternal(node, path, signal));
    }
    private async readInternal(node: NodeEntity, path: string, signal?: AbortSignal) {
        const expected = size(node);
        const file = await open(path, 'wx', 0o600);
        let count = 0;
        try {
            const downloader = await this.sdk.getFileDownloader(node.uid, signal);
            const controller = downloader.downloadToStream(new WritableStream<Uint8Array>({
                write: async chunk => {
                    count += chunk.length;
                    if (count > expected) throw new Error('Oversized download');
                    await file.writeFile(chunk);
                },
            }));
            await controller.completion();
            if (count !== expected) throw new Error('Truncated download');
        } finally { await file.close(); }
        const id = name(node);
        if (id !== 'config' && await digest(Bun.file(path), 'sha256', signal) !== id)
            throw new Error('Restic object digest mismatch');
    }
    put(type: string, id: string, path: string, signal?: AbortSignal) {
        return this.exclusive(type, signal, async () => {
            signal?.throwIfAborted();
            try { await this.putInternal(type, id, path, signal); }
            catch (error) { this.invalidate(this.parent(type)); throw error; }
        });
    }
    private async putInternal(type: string, id: string, path: string, signal?: AbortSignal) {
        const file = Bun.file(path);
        const sha1 = await digest(file, 'sha1', signal);
        if (type !== 'config' && await digest(file, 'sha256', signal) !== id)
            throw new HttpError(400, 'Object digest mismatch');
        const existing = await this.find(type, id, signal);
        if (existing) {
            // Compare actual verified bytes, including config, before acknowledging a retry.
            const checkPath = `${path}.existing`;
            try {
                await this.read(existing, checkPath, signal);
                if (await digest(Bun.file(checkPath), 'sha256') !== await digest(file, 'sha256', signal))
                    throw new HttpError(409, 'Immutable object already exists with different content');
            } finally { await rm(checkPath, { force: true }); }
            return;
        }
        const uploader = await this.sdk.getFileUploader(this.parent(type), id, {
            mediaType: 'application/octet-stream', expectedSize: file.size, expectedSha1: sha1,
        }, signal);
        const controller = await uploader.uploadFromStream(file.stream(), []);
        const { nodeUid, nodeRevisionUid } = await controller.completion();
        const committed = await this.node(nodeUid, signal);
        if (name(committed) !== id || size(committed) !== file.size || committed.activeRevision?.uid !== nodeRevisionUid)
            throw new Error('Committed revision metadata differs from upload');
        if (this.auditUploads) {
            const checkPath = `${path}.audit`;
            try {
                await this.read(committed, checkPath, signal);
                if (await digest(Bun.file(checkPath), 'sha256', signal) !== await digest(file, 'sha256', signal))
                    throw new Error('Committed content differs from uploaded content');
            } finally { await rm(checkPath, { force: true }); }
        }
        this.remember(this.parent(type), committed);
    }
    remove(type: string, id: string, signal?: AbortSignal) {
        return this.exclusive(type, signal, async () => {
            try {
                const node = await this.find(type, id, signal);
                if (!node) return;
                await this.results(this.sdk.trashNodes([node.uid], signal));
                const index = this.indexes.get(this.parent(type));
                if (index?.get(id)?.uid === node.uid) index.delete(id);
                this.reverse.delete(node.uid);
                this.generation++;
            } catch (error) { this.invalidate(this.parent(type)); throw error; }
        });
    }
    private async results(results: AsyncIterable<{ ok: boolean; error?: Error }>) {
        let count = 0;
        for await (const result of results) {
            count++;
            if (!result.ok) throw result.error || new Error('Drive deletion failed');
        }
        if (count !== 1) throw new Error('Incomplete deletion result');
    }
}
