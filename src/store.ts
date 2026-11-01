import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
export async function digest(file: Blob, algorithm: string) {
    const hash = createHash(algorithm);
    for await (const chunk of file.stream()) hash.update(chunk);
    return hash.digest('hex');
}

// One dedicated repository folder, accessed by one adapter process.
export class DriveStore {
    private folders = new Map<string, string>();
    private journal: string;
    private indexes = new Map<string, Map<string, NodeEntity>>();
    private reverse = new Map<string, string>();
    private scans = new Map<string, Promise<Map<string, NodeEntity>>>();
    private generation = 0;
    private mutation: Promise<unknown> = Promise.resolve();
    private eventQueue: Promise<void> = Promise.resolve();
    private exclusive<T>(action: () => Promise<T>): Promise<T> {
        const next = this.mutation.then(action);
        this.mutation = next.catch(() => {});
        return next;
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
    private async indexed(parent: string, fresh = false): Promise<Map<string, NodeEntity>> {
        if (!fresh && this.indexes.has(parent)) return this.indexes.get(parent)!;
        const existing = this.scans.get(parent);
        if (existing) return existing;
        const scan = (async () => {
            for (let attempt = 0; attempt < 4; attempt++) {
                const generation = this.generation;
                const nodes = await this.children(parent);
                if (generation !== this.generation) continue;
                const index = new Map(nodes.map(node => [name(node), node]));
                for (const node of this.indexes.get(parent)?.values() || []) this.reverse.delete(node.uid);
                this.indexes.set(parent, index);
                for (const node of nodes) this.reverse.set(node.uid, name(node));
                return index;
            }
            throw new HttpError(503, 'Repository changed during listing; retry');
        })();
        this.scans.set(parent, scan);
        try { return await scan; }
        finally { this.scans.delete(parent); }
    }
    constructor(private sdk: ProtonDriveClient, private root: string, stateDir: string) {
        this.journal = join(stateDir, `delete-${createHash('sha256').update(root).digest('hex')}.json`);
    }
    async open() {
        const root = await this.sdk.getNode(this.root);
        name(root);
        if (root.type !== NodeType.Folder || root.trashTime) throw new Error('Repository must be an active folder');
        await this.recoverDeletion();
        for (const node of (await this.indexed(this.root, true)).values()) {
            const n = name(node);
            if (types.includes(n)) {
                if (node.type !== NodeType.Folder) throw new Error('Invalid repository layout');
                this.folders.set(n, node.uid);
            } else if (n !== 'config') throw new Error('Use a dedicated repository folder');
        }
    }
    create() { return this.exclusive(() => this.createInternal()); }
    private async createInternal() {
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
    private async children(uid: string) {
        const result: NodeEntity[] = [];
        const seen = new Set<string>();
        for await (const node of this.sdk.iterateFolderChildren(uid)) {
            const n = name(node);
            if (seen.has(n)) throw new Error('Duplicate Drive name');
            seen.add(n);
            result.push(node);
        }
        return result;
    }
    async list(type: string) {
        return [...(await this.indexed(this.parent(type), true)).values()].map(node => {
            const n = name(node);
            if (!/^[a-f0-9]{64}$/.test(n)) throw new Error('Unexpected repository entry');
            return { name: n, size: size(node) };
        });
    }
    async find(type: string, id: string) {
        const parent = this.parent(type);
        const known = (await this.indexed(parent)).get(id);
        if (!known) return;
        try {
            const node = await this.sdk.getNode(known.uid);
            name(node);
            if (node.trashTime || node.parentUid !== parent) { this.invalidate(parent); throw new Error('Repository object moved or trashed'); }
            if (name(node) !== id) { this.invalidate(parent); throw new Error('Repository object renamed'); }
            return node;
        } catch (error) { this.invalidate(parent); throw error; }
    }
    async read(node: NodeEntity, path: string, signal?: AbortSignal) {
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
        if (id !== 'config' && await digest(Bun.file(path), 'sha256') !== id)
            throw new Error('Restic object digest mismatch');
    }
    put(type: string, id: string, path: string, signal?: AbortSignal) {
        return this.exclusive(async () => {
            signal?.throwIfAborted();
            try { await this.putInternal(type, id, path, signal); }
            catch (error) { this.invalidate(this.parent(type)); throw error; }
        });
    }
    private async putInternal(type: string, id: string, path: string, signal?: AbortSignal) {
        const file = Bun.file(path);
        const sha1 = await digest(file, 'sha1');
        if (type !== 'config' && await digest(file, 'sha256') !== id)
            throw new HttpError(400, 'Object digest mismatch');
        const existing = await this.find(type, id);
        if (existing) {
            // Compare actual verified bytes, including config, before acknowledging a retry.
            const checkPath = `${path}.existing`;
            try {
                await this.read(existing, checkPath, signal);
                if (await digest(Bun.file(checkPath), 'sha256') !== await digest(file, 'sha256'))
                    throw new HttpError(409, 'Immutable object already exists with different content');
            } finally { await rm(checkPath, { force: true }); }
            return;
        }
        const uploader = await this.sdk.getFileUploader(this.parent(type), id, {
            mediaType: 'application/octet-stream', expectedSize: file.size, expectedSha1: sha1,
        }, signal);
        const controller = await uploader.uploadFromStream(file.stream(), []);
        const { nodeUid } = await controller.completion();
        const checkPath = `${path}.committed`;
        try {
            const committed = await this.sdk.getNode(nodeUid);
            await this.read(committed, checkPath, signal);
            if (await digest(Bun.file(checkPath), 'sha256') !== await digest(file, 'sha256'))
                throw new Error('Committed content differs from uploaded content');
            this.remember(this.parent(type), committed);
        } finally { await rm(checkPath, { force: true }); }
    }
    remove(type: string, id: string) {
        return this.exclusive(async () => {
            try { await this.removeInternal(type, id); }
            catch (error) { this.invalidate(this.parent(type)); throw error; }
        });
    }
    private async removeInternal(type: string, id: string) {
        await this.recoverDeletion();
        const node = await this.find(type, id);
        if (!node) return;
        const record = { uid: node.uid, parent: this.parent(type) };
        // Durable intent survives a crash between trashing and permanent deletion.
        const file = await open(`${this.journal}.tmp`, 'w', 0o600);
        try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
        finally { await file.close(); }
        await rename(`${this.journal}.tmp`, this.journal);
        const directory = await open(join(this.journal, '..'), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        await this.recoverDeletion();
    }
    private async recoverDeletion() {
        if (!await Bun.file(this.journal).exists()) return;
        const { uid, parent } = await Bun.file(this.journal).json();
        const nodes = await Array.fromAsync(this.sdk.iterateNodes([uid]));
        if (nodes.length !== 1) throw new Error('Incomplete deletion lookup');
        const node = nodes[0];
        if (!('missingUid' in node)) {
            if (node.parentUid !== parent) throw new Error('Deletion target moved; manual review required');
            if (!node.trashTime) await this.results(this.sdk.trashNodes([uid]));
            await this.results(this.sdk.deleteNodes([uid]));
        }
        const oldName = this.reverse.get(uid);
        for (const index of this.indexes.values()) if (oldName && index.get(oldName)?.uid === uid) index.delete(oldName);
        this.reverse.delete(uid);
        this.generation++;
        await rm(this.journal);
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
