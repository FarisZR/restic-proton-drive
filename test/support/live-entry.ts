// Live fault checkpoints. Bundled ONLY by docker/Fault.Dockerfile.
import { AsyncLocalStorage } from 'node:async_hooks';
import { open, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProtonDriveClient } from '@protontech/drive-sdk';
import { DriveStore } from '../../src/store';
import { RequestHTTPClient, requestSignal } from '../../src/request-context';
import { confirmedMutation } from './fault-response';
import { atomicWrite } from '../../src/session';

const operation = new AsyncLocalStorage<{ size?: number; type?: string }>();
const uploader = ProtonDriveClient.prototype.getFileUploader;
ProtonDriveClient.prototype.getFileUploader = async function (...args) {
    const result = await uploader.apply(this, args);
    const upload = result.uploadFromStream.bind(result);
    result.uploadFromStream = (...streamArgs) => operation.run({ size: args[2].expectedSize || 0 }, () => upload(...streamArgs));
    return result;
};
const put = DriveStore.prototype.put;
DriveStore.prototype.put = async function (...args) {
    await put.apply(this, args);
    if (args[0] === 'locks' && process.env.FAULT_DIR)
        await appendFile(join(process.env.FAULT_DIR, 'lock-writes.jsonl'), JSON.stringify({ id: args[1], at: Date.now() }) + '\n');
};
const remove = DriveStore.prototype.remove;
DriveStore.prototype.remove = function (...args) { return operation.run({ type: args[0] }, () => remove.apply(this, args)); };
const fetchJson = RequestHTTPClient.prototype.fetchJson;
RequestHTTPClient.prototype.fetchJson = async function (options) {
    const op = operation.getStore();
    const commit = options.method === 'PUT' && /\/files\/[^/]+\/revisions\/[^/]+$/.test(options.url) && (op?.size || 0) >= 1024 * 1024;
    const trash = options.method === 'POST' && options.url.endsWith('/trash_multiple') && op?.type === 'snapshots';
    const checkpoint = async (phase: string) => {
        const dir = process.env.FAULT_DIR!;
        if (!dir || !await Bun.file(join(dir, 'plan.json')).exists()) return;
        const plan = await Bun.file(join(dir, 'plan.json')).json();
        if (plan.phase !== phase || !/^[a-z0-9_-]+$/.test(plan.id)) return;
        try { const claim = await open(join(dir, `claim-${plan.id}`), 'wx'); await claim.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
        const record = { id: plan.id, phase, enteredAt: Date.now(), leftAt: null as number | null };
        const marker = join(dir, `reached-${plan.id}.json`);
        await atomicWrite(marker, JSON.stringify(record));
        try {
            while (!await Bun.file(join(dir, `release-${plan.id}`)).exists()) {
                requestSignal(options.signal)?.throwIfAborted(); await Bun.sleep(20);
            }
        } finally { record.leftAt = Date.now(); await atomicWrite(marker, JSON.stringify(record)); }
    };
    if (commit) await checkpoint('before-commit');
    const response = await fetchJson.call(this, options);
    if (response.ok && (commit || trash)) {
        const result = await response.clone().json();
        const confirmed = confirmedMutation(result, trash ? (options.json as any).LinkIDs : undefined);
        if (confirmed && commit) await checkpoint('after-commit');
        if (confirmed && trash) await checkpoint('after-trash');
    }
    return response;
};
if (process.argv[2] === 'find-repository') {
    const { initSession } = await import('../../src/session');
    const app = await initSession();
    const root = await app.sdk.getMyFilesRootFolder();
    let found: string | undefined;
    for await (const uid of app.sdk.iterateFolderChildrenNodeUids(root.uid)) {
        const node = await app.sdk.getNode(uid);
        if (node.name.ok && node.name.value === process.argv[3]) { found = node.uid; break; }
    }
    await app.dispose();
    if (!found) throw new Error('Repository folder not found');
    console.log(found); process.exit(0);
} else if (process.argv[2] === 'verify-trash') {
    const { initSession } = await import('../../src/session');
    const target = process.argv[3];
    if (!/^[a-f0-9]{64}$/.test(target || '')) throw new Error('verify-trash requires a snapshot object ID');
    const app = await initSession();
    let found = false;
    let batch: string[] = [];
    const inspect = async () => {
        for await (const node of app.sdk.iterateNodes(batch))
            if (!('missingUid' in node) && node.name.ok && node.name.value === target) found = true;
        batch = [];
    };
    for await (const uid of app.sdk.iterateTrashedNodeUids()) {
        batch.push(uid);
        if (batch.length === 30) await inspect();
        if (found) break;
    }
    if (!found && batch.length) await inspect();
    await app.dispose();
    console.log(found ? 'PASS: snapshot remains recoverable in Proton Trash' : 'FAIL: snapshot not found in Trash');
    process.exit(found ? 0 : 1);
} else await import('../../src/main');
