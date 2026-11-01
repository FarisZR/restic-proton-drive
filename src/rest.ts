import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriveStore, HttpError, MAX, size, types } from './store';

export function range(header: string | null, length: number): [number, number] | undefined {
    if (!header) return;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!m || (!m[1] && !m[2])) throw new HttpError(416, 'Invalid range');
    const start = m[1] ? Number(m[1]) : Math.max(0, length - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(length - 1, Number(m[2])) : length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= length)
        throw new HttpError(416, 'Unsatisfiable range');
    return [start, end];
}

export function handler(store: DriveStore, token: string, spoolDir = tmpdir()) {
    const expected = Buffer.from(`Basic ${Buffer.from(`backup:${token}`).toString('base64')}`);
    let tail: Promise<unknown> = Promise.resolve();
    let pending = 0;
    return async (request: Request): Promise<Response> => {
        const auth = Buffer.from(request.headers.get('authorization') || '');
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="backup"' } });
        if (pending >= 8) return new Response('Busy', { status: 503, headers: { 'Retry-After': '2' } });
        pending++;
        const previous = tail;
        const { promise, resolve } = Promise.withResolvers<void>();
        tail = promise;
        await previous;
        let dir: string | undefined;
        let streaming = false;
        try {
            request.signal.throwIfAborted();
            const url = new URL(request.url);
            const path = url.pathname;
            if (path === '/') {
                if (request.method === 'POST' && url.search === '?create=true') {
                    await store.create(); return new Response();
                }
                throw new HttpError(request.method === 'DELETE' ? 403 : 404, 'Repository removal disabled');
            }
            const m = /^\/(config|data|index|keys|locks|snapshots)(?:\/([a-f0-9]{64})|\/)?$/.exec(path);
            if (!m || (m[1] === 'config' && path !== '/config')) throw new HttpError(404, 'Unknown path');
            const type = m[1], id = type === 'config' ? 'config' : m[2];
            if (!id) {
                if (request.method !== 'GET' || !path.endsWith('/') || !types.includes(type))
                    throw new HttpError(405, 'Method not allowed');
                const list = await store.list(type);
                const v2 = request.headers.get('accept')?.includes('application/vnd.x.restic.rest.v2');
                return new Response(JSON.stringify(v2 ? list : list.map(x => x.name)), {
                    headers: { 'Content-Type': `application/vnd.x.restic.rest.v${v2 ? 2 : 1}` },
                });
            }
            if (request.method === 'DELETE') { await store.remove(type, id); return new Response(); }
            if (!['POST', 'GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
            dir = await mkdtemp(join(spoolDir, 'restic-proton-'));
            const objectPath = join(dir, 'object');
            if (request.method === 'POST') {
                const writer = Bun.file(objectPath).writer();
                let count = 0;
                try {
                    if (request.body) for await (const chunk of request.body) {
                        count += chunk.length;
                        if (count > MAX) throw new HttpError(413, 'Object exceeds 64 MiB');
                        writer.write(chunk);
                        await writer.flush();
                    }
                } finally { await writer.end(); }
                const claimed = request.headers.get('content-length');
                if (claimed !== null && Number(claimed) !== count) throw new HttpError(400, 'Truncated request');
                request.signal.throwIfAborted();
                await store.put(type, id, objectPath, request.signal);
                return new Response();
            }
            const node = await store.find(type, id);
            if (!node) throw new HttpError(404, 'Object not found');
            const length = size(node);
            const headers = new Headers({ 'Content-Length': String(length), 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
            if (request.method === 'HEAD') return new Response(null, { headers });
            let slice;
            try { slice = range(request.headers.get('range'), length); }
            catch (error) { headers.set('Content-Range', `bytes */${length}`); return new Response(null, { status: 416, headers }); }
            await store.read(node, objectPath, request.signal);
            const [start, end] = slice || [0, length - 1];
            headers.set('Content-Length', String(Math.max(0, end - start + 1)));
            if (slice) headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
            // Keep at most one response spool alive; backpressure also bounds disk use.
            const reader = Bun.file(objectPath).slice(start, end + 1).stream().getReader();
            const responseDir = dir;
            dir = undefined;
            streaming = true;
            let released = false;
            const cleanup = async () => {
                if (released) return;
                released = true;
                try { await reader.cancel(); }
                finally {
                    try { await rm(responseDir, { recursive: true, force: true }); }
                    finally { pending--; resolve(); }
                }
            };
            return new Response(new ReadableStream({
                async pull(controller) {
                    try {
                        const { done, value } = await reader.read();
                        if (done) { controller.close(); await cleanup(); }
                        else controller.enqueue(value);
                    } catch (error) { controller.error(error); await cleanup(); }
                },
                cancel: cleanup,
            }), { status: slice ? 206 : 200, headers });
        } catch (error) {
            if (!(error instanceof HttpError)) console.error(error);
            return new Response(error instanceof HttpError ? error.message : 'Storage operation failed', {
                status: error instanceof HttpError ? error.status : 500,
            });
        } finally {
            try { if (dir) await rm(dir, { recursive: true, force: true }); }
            finally { if (!streaming) { pending--; resolve(); } }
        }
    };
}
