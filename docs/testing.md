# Reliability testing

Tests run on Linux x86-64 on 2026-11-01 with Bun 1.4.4, restic **0.19.1** (Go 1.26.4), and the pinned Proton SDK `b68d64bd9f9c1f24be521c8b423c26f5dca1c681`. ARM64 execution uses QEMU; it is not a physical ARM board test.

## Version 0.3 review fixes

The current suite contains 38 tests. The review regressions exercise the actual pinned SDK's ID enumeration, metadata-loading and public transformation code. The simulated API enumerates two children but omits one metadata result: the deprecated convenience iterator demonstrably returns one object, while the adapter rejects data, snapshot and lock listings and cannot install a partial lookup index.

Additional tests cover five blocked bulk requests with eight successful lock write/list/delete cycles; normal new uploads downloading zero bytes; optional audit failure on corrupt remote data; metadata deadlines canceling all admitted iterators and allowing new work only after they stop; the real SDK mapper draining outstanding decrypt work before a canceled operation releases admission; transport cancellation for SDK metadata methods without signal arguments; canceled queue jobs never running or overtaking an active job; and a failed refresh-token save being retried before the SDK's changed-token shortcut, followed by restart loading the rotated token. The persistence test also makes error logging fail and checks the retry obligation survives.

Deletion tests now assert that the exact object remains in Trash across restart and lost acknowledgments, unrelated objects survive, and no permanent-delete call occurs. Permanent deletion and the local deletion journal have been removed. The real-restic proxy/fault campaign passed with strict listings, cancellation and the new upload acknowledgment boundary.

Live tests now use a separate instrumented test image with checkpoints at actual API commit and trash phases. The production image has no checkpoint code. Before acting, the controller requires a recorded held operation; a missed or never-reached phase fails the test. Phase-synchronized campaigns confirmed network removal immediately before a bulk commit, SIGKILL after the commit HTTP response but before the SDK consumed it, and SIGKILL after trashing a snapshot but before acknowledgment. Full checks, cold-cache manifest comparisons and retained-snapshot restoration passed after each relevant phase.

A separate live campaign held a bulk commit for 296 seconds while a real restic lock refresh successfully completed. Its subsequent full check, restore and trash-acknowledgment interruption also passed. The removed snapshot was independently found in Proton Trash. A later trash-only campaign additionally required the successful per-object multi-status API response before killing the container; its retained snapshot passed full checking and restoration. Fresh-state recovery then used a new login/session, external key, REST token and empty state volume; it discovered the repository through Proton, checked all 17 active packs across six snapshots, and restored the latest 44 MiB logical fixture with byte/mode/link-manifest and hardlink checks. No previous adapter session, client UID, key, SQLite cache, lookup index or pack cache was copied. These tests do not establish long-term operation or hundreds-of-GB scale.

## Version 0.2 validation: headless login and production performance fixes

The earlier version 0.2 suite had 28 tests. In addition to the original fault/recovery cases below, it verifies:

- A 10,000-object directory: 1,000 successful point lookups and 100 misses require one complete directory traversal. Explicit REST listings still traverse completely and fail on broken pages.
- Drive node events update lookups without rescanning; refresh events invalidate and rebuild. Concurrent identical POSTs publish one remote object and return four valid acknowledgments.
- Four concurrent ranges share one verified pack download. LRU eviction, capacity reservations, pinned entries, cancellation of one/all waiters and corrupt local cache files are exercised.
- Full GETs and full-object ranges bypass a good cache and detect injected remote corruption. A cached partial read may return previously verified immutable bytes, so remote-integrity tests now deliberately use full reads.
- Slow writes and saturated transfer admission do not block healthchecks. In a live-account sample, all 20 health requests returned successfully, with a maximum measured latency of 23 ms on this host.
- AES-256-GCM session storage, rejection of plaintext sessions, encrypted reload, wrong/missing keys, modified nonce/tag/ciphertext, truncated authentication tags and unknown versions fail closed. Session access/refresh tokens are not present in the stored envelope.
- The official account SDK's browser-fork flow handles a pending-approval response, receives an authenticated encrypted payload, hands the resulting credentials to the session store, and can be canceled. No callback listener or pasted redirect is used. The live test account does not have 2FA enabled, so actual second-factor interaction remains a manual browser test; the SDK protocol/approval exchange is covered with a fixture.

The expanded real-restic fault campaign passed with the lookup index, four transfer slots and pack cache enabled. The live Proton state volume used an encrypted session and completed another baseline/incremental backup, container pause/network removal/SIGKILL recovery, full checks, both cold-cache restores, retention and post-prune restore. The repository layout did not change. Session encryption uses a separately mounted test key; no credentials or keys are committed.

## Repeatable tests

```sh
bun install --frozen-lockfile
bun run check
bun run test
RESTIC_BIN=/path/to/restic bun run stress
```

The automated stress test uses the production HTTP handler, DriveStore and verified pack cache with a fault-injectable implementation of the SDK boundary. It runs a real restic client through a socket-dropping, throttled HTTP proxy. It does not require a Proton account. All its repositories and fixtures are temporary. It retains logs and artifacts under the path printed at the end.

The original unit/integration coverage includes:

- HTTP v1/v2, authentication, exact lengths, range boundaries, zero-length objects and unknown REST versions.
- Truncated/slow incoming bodies, canceled outgoing streams, saturated admission queues, an expired transfer deadline and unavailable spool storage. Healthy requests must work afterward.
- Upload failures, lost commit acknowledgments, duplicate writes and immutable config. New objects use SDK integrity checks and confirmed commits; optional read-back audits and verified immutable retries are covered.
- Truncated downloads, corrupt bytes, invalid signatures, broken listing pages and undecryptable entries. Failed reads cannot emit a successful partial body or range.
- Newer/malformed required SDK versions and unsupported feature masks, including masks larger than 32 bits.
- Fifty concurrent atomic session saves, mode-0600 persistence, survival of a failed session-file write, reload and rejection of malformed credentials; concurrent expired-token requests trigger one account-SDK refresh and persist the new access and refresh tokens to disk.
- Crash/lost-acknowledgment recovery for trash-only removal. A fresh provider/store reads on-disk provider state, retries are idempotent, and the object remains recoverable.
- Sixty-four cycles of mixed writes, ranges and deletes with injected lost acknowledgments.

The initial campaign ran the real-restic stress test five times with independently generated random data; the version 0.2 campaign above adds runs with indexing and caching enabled. The final expanded run covers:

| Scenario | Required result | Observed |
| --- | --- | --- |
| 1,011 files, 88 MiB logical source including 24 MiB random data | Backup and cold-cache restore match SHA-256, modes, names and link targets | Pass |
| Throttled uploads (~6 MiB/s), slow SDK transfers, two mid-upload socket drops, SDK 503s and lost commit acknowledgments | Incremental backup completes through restic retries | Pass |
| Download drops and failed listing pages | Full data check and latest/historical restores succeed after retries | Pass |
| SIGKILL/restart of the test server | Persisted repository remains readable and restorable | Pass |
| Retention and prune | Full check and restore of retained snapshot succeed | Pass |
| Corrupt committed pack; full remote read requested | Server fails before sending object content | Pass |
| Missing committed pack | Both check and restore fail; restoring the provider object permits a verified restore | Pass |
| Wrong repository password | Repository access fails | Pass |
| Restore over damaged files with stale extras | `--verify --delete --sparse` reconstructs the manifest | Pass |
| Selective restore | Selected binary file matches the source | Pass |

Fixtures include empty files/directories, all byte values, sparse data, hardlinks, dangling and looping symlinks, executable and read-only modes, case-sensitive names, Unicode, newlines and a 240-character filename. Every normal restore discards the restic cache and compares a fresh filesystem manifest; restic's `--verify` is enabled too.

## Live Proton and Docker

The amd64 image signed into the disposable test account, created a dedicated repository, backed up 157-file fixtures with 12/24 MiB random data and a 32 MiB sparse file, and restored both original and changed snapshots. During backup, the test paused the container for three seconds, disconnected its Docker network for five seconds, then sent SIGKILL and restarted it. Restic retries must complete, followed by full-content checks, cold-cache manifest comparisons, pruning and another restore.

The initial live fault sequence found an upstream PID-lock problem when Docker reused a PID after SIGKILL. The container now holds a kernel `flock` for the server lifetime and replaces the SDK event PID lock only while holding that lock. The first live sequence recovered after the corrected image was started and passed all subsequent checks/restores. A second complete live sequence then passed independently from the corrected image, including backup recovery, full checks, both snapshot restores, pruning and post-prune restoration.

The final local OCI manifest contains both linux/amd64 and linux/arm64. Compose startup with `--wait`, its healthcheck, restart/session reuse and refusal of a concurrent container were also verified. Both architecture images build and execute; neither contains restic. The arm64 container has also created a live Proton repository, backed up three files (1 MiB logical), passed a full data check, and restored and compared those files under QEMU.

Run live tests only against a dedicated disposable repository. Build the separate test image:

```sh
docker build -t restic-proton-drive:review .
docker build -f docker/Fault.Dockerfile -t restic-proton-drive:fault-review .
```

Start that image on Docker's `bridge` network with the usual private state volume/key, plus a writable host directory bind-mounted at `/fault` and `FAULT_DIR=/fault`. It must already be authenticated/configured. The checkpoint code is test-only and must not be used for backups.

```sh
LIVE_DISPOSABLE=1 \
STRESS_CONTAINER=your-disposable-fault-container \
FAULT_DIR=/host/path/to/mounted-fault-directory \
REST_TOKEN_FILE=/private/token \
RESTIC_PASSWORD_FILE=/private/restic-password \
RESTIC_REPOSITORY=rest:http://127.0.0.1:18000/ \
RESTIC_BIN=/path/to/restic \
LOCK_REFRESH_SOAK=1 \
python3 scripts/live-container-stress.py
```

The named container is disconnected/killed/restarted. Add `SKIP_INIT=1` for an initialized test repository. `LOCK_REFRESH_SOAK=1` adds a held bulk commit and waits for a subsequent successful lock write; restic 0.19.1's refresh interval is five minutes. Each run uses unique snapshot tags. `TRASH_ONLY=1` runs just the trash-acknowledgment fault with two small snapshots; the hook validates Proton’s single/multi-status success codes and exact per-object results. A test fails if the targeted checkpoint is not reached or was already released before the fault. Commit/trash response checkpoints additionally require successful Proton API result codes, not only HTTP 200. Earlier sleep-based campaigns verified recovery after disruptions but did not prove which operation was active; they are not evidence of commit-phase coverage.

Earlier independent recovery validation downloaded the repository with the official CLI's unmodified filesystem-download implementation, converted the flat pack directory to local restic shards, and passed plain-restic full checking and restoration without the adapter or cache. See [operations.md](operations.md).

## Continuous integration

Every push and pull request runs type checks, the unit/integration suite and the real-restic fault test. Successful tests gate Docker builds and runtime smoke tests for amd64 and arm64. Pushes publish a multi-platform GHCR image tagged by branch and commit; the default branch also updates `latest`. CI does not contain Proton credentials or call the live account.

## Boundaries

These checks establish observed behavior, not a guarantee against every storage failure. Backend 503s, corruption and version mismatches are injected at the SDK boundary; live tests do not control Proton's servers. Token refresh is tested against a local account-API fixture, while real login/session reuse are tested against Proton. Multi-day real token refresh, service migrations, physical power loss, quota-accounting delays, multi-terabyte repositories, and physical ARM hardware remain untested. Keep independent copies of the repository password and exercise actual recovery periodically.
