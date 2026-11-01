import { ApiClient, type ApiClientOptions, type SessionInfo } from 'proton-drive-sdk-account';
import type { Logger } from '@protontech/drive-sdk';
import { Credentials } from '../sdk/cli/src/credentials/credentials';
import type { Credentials as Snapshot, CredentialsStore } from '../sdk/cli/src/credentials/interface';
import { requestSignal } from './request-context';

class PendingStore implements CredentialsStore {
    private pending?: Snapshot;
    private tail: Promise<unknown> = Promise.resolve();
    private retry?: ReturnType<typeof setTimeout>;
    constructor(private target: CredentialsStore, private logger: Logger) {}
    load() { return this.target.load(); }
    save(snapshot: Snapshot) { this.pending = snapshot; return this.flush(); }
    flush() {
        const task = this.tail.then(async () => {
            while (this.pending) {
                const snapshot = this.pending;
                await this.target.save(snapshot);
                if (this.pending === snapshot) this.pending = undefined;
            }
            clearTimeout(this.retry); this.retry = undefined;
        });
        this.tail = task.catch(() => {
            try { this.logger.error('Session persistence failed; retaining new credentials and retrying'); } catch {}
            if (!this.retry) {
                this.retry = setTimeout(() => { this.retry = undefined; void this.flush().catch(() => {}); }, 5000);
                this.retry.unref();
            }
        });
        return task;
    }
    async remove() { await this.tail; await this.target.remove(); this.pending = undefined; clearTimeout(this.retry); }
    async close() { clearTimeout(this.retry); await this.flush(); }
}

export class DurableCredentials extends Credentials {
    private persistence: PendingStore;
    private listeners = new Set<() => void>();
    constructor(store: CredentialsStore, logger: Logger) {
        const persistence = new PendingStore(store, logger);
        super(persistence, logger); this.persistence = persistence;
    }
    override on(event: 'sessionInfoChanged', callback: () => void) {
        super.on(event, callback); this.listeners.add(callback);
    }
    override async setSessionInfo(info: SessionInfo) {
        try { await super.setSessionInfo(info); }
        catch (error) {
            // Keep transport headers consistent with the new in-memory token.
            for (const listener of this.listeners) listener();
            throw error;
        }
    }
    override async getCachePassword() { await this.flush(); return super.getCachePassword(); }
    flush() { return this.persistence.flush(); }
    close() { return this.persistence.close(); }
}

export class SessionApiClient extends ApiClient {
    constructor(private config: ApiClientOptions & { credentials: DurableCredentials }) { super(config); }
    override get authenticatedRequest() {
        return super.authenticatedRequest.extend({ signal: requestSignal(), hooks: {
            beforeRequest: [async () => { await this.config.credentials.flush(); }],
        } });
    }
    override get unauthenticatedRequest() { return super.unauthenticatedRequest.extend({ signal: requestSignal() }); }
    override async refreshSessionIfPossible(rejectedAccessToken?: string) {
        // This must precede the SDK's "token already changed" shortcut.
        await this.config.credentials.flush();
        const result = await super.refreshSessionIfPossible(rejectedAccessToken);
        await this.config.credentials.flush();
        return result;
    }
}
