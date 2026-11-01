// A fault-injectable SDK boundary, never included in the production image.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';
import { atomicWrite } from '../../src/session';

export type Faults = { delay?: number; upload?: number; download?: number; listing?: number;
    lostAck?: number; corruptUpload?: number; corruptRead?: number; truncateRead?: number;
    signature?: number; trash?: number; permanent?: number; deleteAck?: number; size?: number; listingEntry?: number };
export class Provider {
    nodes: Record<string, NodeEntity> = {};
    faults: Faults = {};
    calls: Record<string, number> = {};
    constructor(public dir: string) {}
    async open() {
        await mkdir(this.dir, { recursive: true });
        if (await Bun.file(join(this.dir, 'nodes.json')).exists()) this.nodes = await Bun.file(join(this.dir, 'nodes.json')).json();
        else { this.node('root', 'repository', 'folder'); await this.save(); }
    }
    private node(uid: string, name: string, type = 'file', parentUid?: string, length = 0) {
        return this.nodes[uid] = { uid, parentUid, name: { ok: true, value: name }, type,
            keyAuthor: { ok: true, value: 'test' }, nameAuthor: { ok: true, value: 'test' },
            activeRevision: type === 'file' ? { uid, claimedSize: length, contentAuthor: { ok: true, value: 'test' } } : undefined } as NodeEntity;
    }
    private save() { return atomicWrite(join(this.dir, 'nodes.json'), JSON.stringify(this.nodes)); }
    private hit(key: keyof Faults) {
        this.calls[key] = (this.calls[key] || 0) + 1;
        if ((this.faults[key] || 0) > 0) { this.faults[key]!--; return true; }
        return false;
    }
    private async delay(signal?: AbortSignal) {
        if (this.faults.delay) await Bun.sleep(this.faults.delay);
        signal?.throwIfAborted();
    }
    get sdk(): ProtonDriveClient { return this as unknown as ProtonDriveClient; }
    async getNode(uid: string) {
        const node = this.nodes[uid];
        if (!node) throw new Error('Node not found');
        return structuredClone(node);
    }
    async *iterateNodes(ids: string[]) { for (const uid of ids) yield this.nodes[uid] ? await this.getNode(uid) : { missingUid: uid }; }
    async *iterateFolderChildren(parentUid: string) {
        this.calls.scans = (this.calls.scans || 0) + 1;
        for (const node of Object.values(this.nodes).filter(n => n.parentUid === parentUid && !n.trashTime)) {
            if (this.hit('listing')) throw new Error('503: interrupted listing page');
            const value = structuredClone(node);
            if (this.hit('listingEntry')) value.name = { ok: false, error: new Error('decryption failed') };
            yield value;
        }
    }
    async createFolder(parent: string, name: string) {
        const uid = crypto.randomUUID(); const node = this.node(uid, name, 'folder', parent);
        await this.save(); return structuredClone(node);
    }
    async getFileUploader(parent: string, name: string, metadata: { expectedSize: number; expectedSha1: string }, signal?: AbortSignal) {
        return { uploadFromStream: async (stream: ReadableStream<Uint8Array>) => ({ completion: async () => {
            if (this.hit('upload')) throw new Error('503: upload unavailable');
            const uid = crypto.randomUUID(); const path = join(this.dir, uid);
            const writer = Bun.file(path).writer(); const hash = createHash('sha1'); let count = 0;
            try {
                for await (const bytes of stream) { await this.delay(signal); count += bytes.length; hash.update(bytes); writer.write(bytes); await writer.flush(); }
            } finally { await writer.end(); }
            if (count !== metadata.expectedSize || hash.digest('hex') !== metadata.expectedSha1) throw new Error('Upload integrity failed');
            if (Object.values(this.nodes).some(n => n.parentUid === parent && !n.trashTime && n.name.ok && n.name.value === name))
                throw new Error('Duplicate name');
            this.node(uid, name, 'file', parent, count);
            if (this.hit('corruptUpload')) await Bun.write(path, new Uint8Array(count));
            await this.save();
            if (this.hit('lostAck')) throw new Error('Connection reset after commit');
            return { nodeUid: uid, nodeRevisionUid: uid };
        } }) };
    }
    async getFileDownloader(uid: string, signal?: AbortSignal) {
        return { downloadToStream: (stream: WritableStream<Uint8Array>) => ({ completion: async () => {
            const writer = stream.getWriter();
            try {
                if (this.hit('download')) throw new Error('503: download unavailable');
                const bytes = await Bun.file(join(this.dir, uid)).bytes();
                if (this.hit('corruptRead') && bytes.length) bytes[0] ^= 1;
                const view = this.hit('truncateRead') ? bytes.subarray(0, Math.max(0, bytes.length - 1)) : bytes;
                for (let offset = 0; offset < view.length; offset += 65536) {
                    await this.delay(signal); await writer.write(view.subarray(offset, offset + 65536));
                }
                if (this.hit('signature')) throw new Error('Invalid signature after final block');
                await writer.close();
            } catch (error) { await writer.abort(error); throw error; }
            finally { writer.releaseLock(); }
        } }) };
    }
    async *trashNodes(ids: string[]) {
        for (const uid of ids) {
            this.nodes[uid].trashTime = new Date(); await this.save();
            if (this.hit('trash')) throw new Error('Disconnected after trash');
            yield { uid, ok: true };
        }
    }
    async *deleteNodes(ids: string[]) {
        for (const uid of ids) {
            if (this.hit('permanent')) throw new Error('503: permanent deletion unavailable');
            delete this.nodes[uid]; await this.save(); await rm(join(this.dir, uid), { force: true });
            if (this.hit('deleteAck')) throw new Error('Lost deletion acknowledgment');
            yield { uid, ok: true };
        }
    }
}
