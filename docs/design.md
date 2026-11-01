# Design and project context

The goal is incremental, automated offsite backups stored directly in Proton Drive, without a full local repository copy. The original environment is a Linux server with 4 vCPUs, 8 GB RAM and limited SSD capacity. Restic supplies snapshots, encryption, deduplication, locking and retention; this project supplies repository-object storage.

The implementation deliberately follows the standard Restic REST protocol. It does not emulate a general filesystem, mount Drive, or change the restic repository format. An earlier discussion considered Rustic and WebDAV; the chosen target is standard restic, currently 0.19.1. Independent recovery through another Drive client is an explicit design goal.

This is an unofficial third-party application, not supported by Proton. The official SDK currently permits personal experimentation and warns about its upcoming cryptographic migration. See [SDK status and usage guidelines](https://github.com/ProtonDriveApps/sdk). SDK updates are therefore an operational dependency, not optional maintenance.

## Components

`restic → local REST server → official Drive SDK → Proton Drive`

The server uses the official account SDK and selected CLI utilities for SRP/browser login, token refresh, encrypted SQLite caches and event subscriptions. A small session bootstrap adds strict requirement-header checks and atomic file persistence. The upstream SDK submodule is pinned and unmodified.

The Docker image contains only the REST server and its login/setup commands. It does not contain restic. The runtime bundle is built from the locked dependencies and does not install packages at startup.

## Storage behavior and limits

- Implements REST v1/v2 listing, initialization, stat, immutable writes, verified reads, byte ranges, and individual deletion. Whole-repository HTTP deletion is forbidden.
- Five bulk and two reserved lock requests run in separate lanes; each lane serializes its mutations. Use restic's default pack size (16 MiB). Objects larger than **64 MiB** are rejected. A transfer uses a temporary file; an idempotent retry can use two files, at most **128 MiB** per admitted transfer, plus SDK metadata/crypto caches and a bounded verified-pack cache. Restart removes stale transfer files.
- Request bodies are fully received before upload. SHA-256 must match the restic object name; the SDK also receives expected size and SHA-1. Success is returned after SDK integrity checks and a confirmed committed revision. Full read-back is an optional audit. Existing committed objects are compared against downloaded, verified bytes; a retry cannot overwrite them. Config is immutable too; in-place repository format migration is not supported.
- Downloads use the SDK's full verification path, including for ranges. An uncached object is fully downloaded and checked before sending any bytes; partial reads can reuse a bounded cache of verified immutable packs. This favors integrity over bandwidth; small random reads can download a whole pack repeatedly. Node's HTTP server preserves the exact length required by restic 0.19.1.
- SDK events maintain its caches. Folder listings are scoped to the requested repository directory. Metadata/decryption failures, duplicate names, unknown entries, and missing sizes fail the operation instead of producing a partial successful listing. An in-memory point-lookup index is rebuilt from complete SDK listings and updated by writes and Drive events. REST listings still traverse the SDK completely.
- Deletion trashes the exact node and never permanently deletes committed objects. Retries reconcile against active objects; no local deletion journal is needed. Quota may remain consumed until Trash is managed in Proton.

The repository's `data` folder is flat, as exposed by the REST protocol. The other folders and `config` are ordinary restic objects. All repository content is restic-encrypted before the SDK adds Drive encryption.


## Correctness choices

New uploads use the SDK's expected-size, block-count and SHA-1 checks and confirmed revision commit as the normal acknowledgment boundary. The adapter also checks incoming SHA-256 names and returned revision metadata. Full remote read-back is an optional audit, and retries compare existing immutable content. This avoids doubling network traffic for every normal upload. Periodic content checks and restores test continued readability.

Complete listings enumerate IDs and validate the corresponding metadata explicitly. The SDK's deprecated convenience iterator can silently omit missing metadata, so it is not used. Point-lookup indexes are installed only after the complete traversal succeeds.

Bulk and lock admission/queues are separate. Metadata and transfer cancellation propagate into supported SDK iterators and the HTTP transport. Slots are released only after work stops. Failed credential persistence retains the pending write and retries before API use and token-refresh shortcuts, plus background retries.

Tests inject faults at the SDK boundary and HTTP transport, then use a real restic client. These tests complement live-account and Docker tests; they do not simulate Proton's entire implementation or guarantee future service behavior. Validation details and remaining limits are in [testing.md](testing.md).
