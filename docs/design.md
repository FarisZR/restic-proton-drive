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
- One operation runs at a time, with at most eight requests admitted. Use restic's default pack size (16 MiB). Objects larger than **64 MiB** are rejected. A transfer uses a temporary file; an idempotent retry can use two files, at most **128 MiB** total, plus small SDK metadata/crypto caches. Restart removes stale transfer files.
- Request bodies are fully received before upload. SHA-256 must match the restic object name; the SDK also receives expected size and SHA-1. Success is returned only after SDK upload completion and verified read-back. Existing committed objects are compared against downloaded, verified bytes; a retry cannot overwrite them. Config is immutable too; in-place repository format migration is not supported.
- Downloads use the SDK's full verification path, including for ranges. The full object is downloaded and checked before sending any bytes. This favors integrity over bandwidth; small random reads can download a whole pack repeatedly. Node's HTTP server preserves the exact length required by restic 0.19.1.
- SDK events maintain its caches. Folder listings are scoped to the requested repository directory. Metadata/decryption failures, duplicate names, unknown entries, and missing sizes fail the operation instead of producing a partial successful listing. No recursive polling loop or separate object catalog.
- Deletion writes a durable local intent, trashes the exact node, then permanently deletes that node. On restart it finishes pending deletion before serving requests. It never empties the account's Trash. Keep the state directory: losing it during deletion can leave an orphan in Trash that needs manual cleanup. Moving a pending deletion target causes a hard failure for manual review.

The repository's `data` folder is flat, as exposed by the REST protocol. The other folders and `config` are ordinary restic objects. All repository content is restic-encrypted before the SDK adds Drive encryption.


## Correctness choices

New uploads are read back through the SDK's full verification path before success is acknowledged. Retrying a committed object verifies its actual bytes; it cannot overwrite existing content. This costs bandwidth, but prioritizes a dependable acknowledgment over throughput. A corrupt committed object produces an error and is retained for investigation instead of silently overwritten.

The server serializes operations and bounds admission at eight requests to keep transfer disk use bounded. It retains the operation gate until a download body is consumed or canceled. Connection loss, temporary disk failures and malformed metadata must release resources or fail explicitly. Listings are returned only after the SDK iterator completes successfully.

Tests inject faults at the SDK boundary and HTTP transport, then use a real restic client. These tests complement live-account and Docker tests; they do not simulate Proton's entire implementation or guarantee future service behavior. Validation details and remaining limits are in [testing.md](testing.md).
