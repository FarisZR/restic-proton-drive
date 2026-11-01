import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';

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
    constructor(private sdk: ProtonDriveClient, private root: string, stateDir: string) {
        this.journal = join(stateDir, `delete-${createHash('sha256').update(root).digest('hex')}.json`);
    }
    async open() {
        const root = await this.sdk.getNode(this.root);
        name(root);
        if (root.type !== NodeType.Folder || root.trashTime) throw new Error('Repository must be an active folder');
        await this.recoverDeletion();
        for (const node of await this.children(this.root)) {
            const n = name(node);
            if (types.includes(n)) {
                if (node.type !== NodeType.Folder) throw new Error('Invalid repository layout');
                this.folders.set(n, node.uid);
            } else if (n !== 'config') throw new Error('Use a dedicated repository folder');
        }
    }
    async create() {
        for (const type of types) if (!this.folders.has(type)) {
            const node = await this.sdk.createFolder(this.root, type);
            this.folders.set(type, node.uid);
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
        return (await this.children(this.parent(type))).map(node => {
            const n = name(node);
            if (!/^[a-f0-9]{64}$/.test(n)) throw new Error('Unexpected repository entry');
            return { name: n, size: size(node) };
        });
    }
    async find(type: string, id: string) {
        return (await this.children(this.parent(type))).find(node => name(node) === id);
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
    async put(type: string, id: string, path: string, signal?: AbortSignal) {
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
            await this.read(await this.sdk.getNode(nodeUid), checkPath, signal);
            if (await digest(Bun.file(checkPath), 'sha256') !== await digest(file, 'sha256'))
                throw new Error('Committed content differs from uploaded content');
        } finally { await rm(checkPath, { force: true }); }
    }
    async remove(type: string, id: string) {
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
