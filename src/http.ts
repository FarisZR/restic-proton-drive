import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function httpServer(fetch: (request: Request) => Promise<Response>) {
    return createServer(async (incoming, outgoing) => {
        const abort = new AbortController();
        outgoing.on('close', () => { if (!outgoing.writableFinished) abort.abort(); });
        try {
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers))
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
            const request = new Request(`http://localhost${incoming.url}`, {
                method: incoming.method, headers, signal: abort.signal,
                body: ['GET', 'HEAD'].includes(incoming.method!) ? undefined : Readable.toWeb(incoming),
                duplex: 'half',
            } as RequestInit);
            const response = await fetch(request);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            if (response.body) await pipeline(Readable.fromWeb(response.body as any), outgoing);
            else outgoing.end();
        } catch (error) { outgoing.destroy(error as Error); }
    });
}
