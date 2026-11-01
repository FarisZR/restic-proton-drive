import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, HttpError } from './store';

type Entry = { path: string; size: number; users: number; controller: AbortController; ready: Promise<void>; removed: boolean };

// Only partial reads use this cache. Full reads always verify the remote copy.
export class PackCache {
    private entries = new Map<string, Entry>();
    private retired = new Set<Entry>();
    private allocation: Promise<unknown> = Promise.resolve();
    constructor(private dir: string, readonly capacity = 256 * 1024 * 1024) {
        if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error('Invalid pack cache capacity');
    }
    async open() {
        await rm(this.dir, { recursive: true, force: true });
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }
    private markRemoved(key: string, entry: Entry) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.removed = true;
        this.retired.add(entry);
    }
    private async clean(entry: Entry) {
        if (entry.users) return;
        entry.controller.abort();
        await entry.ready.catch(() => {});
        await rm(entry.path, { force: true });
        this.retired.delete(entry);
    }
    private reserve(id: string, size: number, download: (path: string, signal: AbortSignal) => Promise<void>) {
        const next = this.allocation.then(async () => {
            let entry = this.entries.get(id);
            if (!entry) {
                let used = [...this.entries.values(), ...this.retired].reduce((sum, e) => sum + e.size, 0);
                for (const [key, old] of this.entries) {
                    if (used + size <= this.capacity) break;
                    if (!old.users) {
                        this.markRemoved(key, old); await this.clean(old); used -= old.size;
                    }
                }
                if (used + size > this.capacity) throw new HttpError(503, 'Verified pack cache is busy');
                entry = { path: join(this.dir, crypto.randomUUID()), size, users: 0, controller: new AbortController(),
                    ready: Promise.resolve(), removed: false };
                const current = entry;
                this.entries.set(id, entry);
                entry.ready = download(entry.path, entry.controller.signal).catch(error => {
                    this.markRemoved(id, current); throw error;
                });
                void entry.ready.catch(() => {});
            }
            this.entries.delete(id); this.entries.set(id, entry); // LRU
            entry.users++;
            return entry;
        });
        this.allocation = next.catch(() => {});
        return next;
    }
    async acquire(id: string, size: number, download: (path: string, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
        signal.throwIfAborted();
        if (!/^[a-f0-9]{64}$/.test(id) || size > this.capacity || !this.capacity) return;
        const entry = await this.reserve(id, size, download);
        let released = false;
        const release = async () => {
            if (released) return;
            released = true;
            entry.users--;
            if (!entry.users && entry.removed) await this.clean(entry);
        };
        let abort!: () => void;
        try {
            await Promise.race([entry.ready, new Promise<never>((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            })]);
            signal.throwIfAborted();
            const file = Bun.file(entry.path);
            // Detect local corruption before sending even a one-byte range.
            if (file.size !== size || await digest(file, 'sha256') !== id) {
                this.markRemoved(id, entry);
                throw new Error('Verified pack cache integrity failure; retry to download again');
            }
            return { path: entry.path, release };
        } catch (error) {
            if (entry.users === 1) this.markRemoved(id, entry);
            await release(); throw error;
        } finally { signal.removeEventListener('abort', abort); }
    }
}
