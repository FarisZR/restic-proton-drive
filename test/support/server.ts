import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Provider } from './provider';
import { DriveStore } from '../../src/store';
import { handler } from '../../src/rest';
import { httpServer } from '../../src/http';
const dir = process.argv[2];
await mkdir(dir, { recursive: true });
const provider = new Provider(join(dir, 'remote'));
await provider.open();
const store = new DriveStore(provider.sdk, 'root', dir);
await store.open();
const spool = join(dir, 'spool'); await rm(spool, { recursive: true, force: true }); await mkdir(spool);
const handle = handler(store, 'test-token-'.repeat(4), spool);
const server = httpServer(async request => {
    if (new URL(request.url).pathname === '/_control') {
        const options = await request.json(); provider.faults = options;
        return Response.json(provider.calls);
    }
    return handle(request);
});
server.listen(Number(process.argv[3] || 0), '127.0.0.1', async () => {
    const address = server.address() as { port: number };
    await Bun.write(join(dir, 'port'), String(address.port));
});
