import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProtonDriveHTTPClientBlobRequest, ProtonDriveHTTPClientJsonRequest } from '@protontech/drive-sdk';
import { HTTPClient } from '../sdk/cli/src/api/httpClient';

const context = new AsyncLocalStorage<AbortSignal>();
export function withSignal<T>(signal: AbortSignal | undefined, action: () => T): T {
    return signal ? context.run(signal, action) : action();
}
export function requestSignal(signal?: AbortSignal) {
    const current = context.getStore();
    return current && signal && current !== signal ? AbortSignal.any([current, signal]) : current || signal;
}

// Some SDK metadata methods have no signal parameter. Their HTTP requests still
// inherit the caller's cancellation context. Shared fills use their own signal.
export class RequestHTTPClient extends HTTPClient {
    override fetchJson(options: ProtonDriveHTTPClientJsonRequest) {
        return super.fetchJson({ ...options, signal: requestSignal(options.signal) });
    }
    override fetchBlob(options: ProtonDriveHTTPClientBlobRequest) {
        return super.fetchBlob({ ...options, signal: requestSignal(options.signal) });
    }
}

export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();
    async run<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
        signal?.throwIfAborted();
        const previous = this.tail;
        const { promise, resolve } = Promise.withResolvers<void>();
        this.tail = promise;
        let abort: (() => void) | undefined;
        try {
            await Promise.race([previous, new Promise<never>((_, reject) => {
                if (!signal) return;
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            })]);
            signal?.throwIfAborted();
            return await withSignal(signal, action);
        } finally {
            if (abort) signal?.removeEventListener('abort', abort);
            // A canceled waiter cannot let its successors overtake the active job.
            void previous.finally(resolve);
        }
    }
}
