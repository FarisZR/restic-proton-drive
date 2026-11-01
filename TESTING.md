# Validation record

Executed on Linux x86-64 on 2026-11-01 using Bun 1.4.4, restic **0.19.1** (Go 1.26.4), and Proton SDK commit `b68d64bd9f9c1f24be521c8b423c26f5dca1c681`.

- Signed into the disposable Proton account using the official account SDK's SRP password flow through the adapter CLI. No credentials are committed. Restarted the adapter and reused the persisted session successfully.
- Initialized a live restic v2 repository directly in a dedicated Proton Drive folder.
- Backed up a text file and 1 MiB of random data, changed the text file, then backed up incrementally. The second backup reused the random data.
- `check --read-data` passed for all objects. Restored with an empty restic cache; recursive comparison with the source passed.
- Removed older snapshots and pruned obsolete indexes and packs with targeted permanent deletion. Another full data check passed.
- Disconnected an HTTP upload of an 8 MiB random object while the SDK was uploading. The subsequent read returned either absence or the complete correct object, then two identical retries succeeded. Checked exact bytes and a byte range. Bad SHA-256/name pairs were rejected without altering stored data. Deletion and deletion retry succeeded.
- Stopped the adapter and downloaded its entire repository using the official CLI's unmodified filesystem-download command implementation. It reported 13 transferred items, zero skipped items and zero failures. Converted only the data directory's flat layout to local restic shards. Plain restic, with no adapter and no cache, passed `check --read-data` and restored the snapshot; the changed document contained the expected second version.
- Eight automated tests cover protocol negotiation, authentication, range validation, exact HTTP Content-Length, storage failures, invalid metadata, duplicate listings, upload failure, digest rejection, and crash recovery between trash and permanent deletion. TypeScript checking passed.

The initial live check exposed Bun.serve stripping Content-Length from streaming responses. The final server uses Node's HTTP API under Bun, with a real-socket regression test for the exact length required by restic 0.19.1. No object corruption was found.

These are small-account functional tests. Multi-day token refresh, reboot-time keychain/GPG availability, account quota accounting delays, thousands of objects, multi-gigabyte backups, SDK migration, and provider outages remain untested. Crash recovery during deletion is tested with an injected SDK failure and a fresh store instance; a machine power failure during a live Drive deletion has not been simulated. An HTTP disconnect during upload was tested against the live account. The independent download used a fresh restic cache and the same machine's authenticated CLI session, rather than a newly provisioned machine.
