# Reliability testing

Tests run on Linux x86-64 on 2026-11-01 with Bun 1.4.4, restic **0.19.1** (Go 1.26.4), and the pinned Proton SDK `b68d64bd9f9c1f24be521c8b423c26f5dca1c681`. ARM64 execution uses QEMU; it is not a physical ARM board test.

## Repeatable tests

```sh
bun install --frozen-lockfile
bun run check
bun run test
RESTIC_BIN=/path/to/restic bun run stress
```

The automated stress test uses the production HTTP handler and DriveStore with a fault-injectable implementation of the SDK boundary. It runs a real restic client through a socket-dropping, throttled HTTP proxy. It does not require a Proton account. All its repositories and fixtures are temporary. It retains logs and artifacts under the path printed at the end.

The 19 unit/integration tests cover:

- HTTP v1/v2, authentication, exact lengths, range boundaries, zero-length objects and unknown REST versions.
- Truncated/slow incoming bodies, canceled outgoing streams, saturated admission queues, an expired transfer deadline and unavailable spool storage. Healthy requests must work afterward.
- Upload failures, lost commit acknowledgments, duplicate writes and immutable config. Newly uploaded objects must pass a verified read-back before acknowledgment.
- Truncated downloads, corrupt bytes, invalid signatures, broken listing pages and undecryptable entries. Failed reads cannot emit a successful partial body or range.
- Newer/malformed required SDK versions and unsupported feature masks, including masks larger than 32 bits.
- Fifty concurrent atomic session saves, mode-0600 persistence, survival of a failed session-file write, reload and rejection of malformed credentials; concurrent expired-token requests trigger one account-SDK refresh and persist the new access and refresh tokens to disk.
- Crash recovery after trash, before permanent deletion, and after a lost permanent-deletion acknowledgment. A fresh provider/store reconstructs state from disk, retries are idempotent, and an unrelated node survives.
- Sixty-four cycles of mixed writes, ranges and deletes with injected lost acknowledgments.

The real-restic stress test has been run five times with independently generated random data. The final expanded run covers:

| Scenario | Required result | Observed |
| --- | --- | --- |
| 1,011 files, 88 MiB logical source including 24 MiB random data | Backup and cold-cache restore match SHA-256, modes, names and link targets | Pass |
| Throttled uploads (~6 MiB/s), slow SDK transfers, two mid-upload socket drops, SDK 503s and lost commit acknowledgments | Incremental backup completes through restic retries | Pass |
| Download drops and failed listing pages | Full data check and latest/historical restores succeed after retries | Pass |
| SIGKILL/restart of the test server | Persisted repository remains readable and restorable | Pass |
| Retention and prune | Full check and restore of retained snapshot succeed | Pass |
| Corrupt committed pack; one-byte range requested | Server fails before sending object content | Pass |
| Missing committed pack | Both check and restore fail; restoring the provider object permits a verified restore | Pass |
| Wrong repository password | Repository access fails | Pass |
| Restore over damaged files with stale extras | `--verify --delete --sparse` reconstructs the manifest | Pass |
| Selective restore | Selected binary file matches the source | Pass |

Fixtures include empty files/directories, all byte values, sparse data, hardlinks, dangling and looping symlinks, executable and read-only modes, case-sensitive names, Unicode, newlines and a 240-character filename. Every normal restore discards the restic cache and compares a fresh filesystem manifest; restic's `--verify` is enabled too.

## Live Proton and Docker

The amd64 image signed into the disposable test account, created a dedicated repository, backed up 157-file fixtures with 12/24 MiB random data and a 32 MiB sparse file, and restored both original and changed snapshots. During backup, the test paused the container for three seconds, disconnected its Docker network for five seconds, then sent SIGKILL and restarted it. Restic retries must complete, followed by full-content checks, cold-cache manifest comparisons, pruning and another restore.

The initial live fault sequence found an upstream PID-lock problem when Docker reused a PID after SIGKILL. The container now holds a kernel `flock` for the server lifetime and replaces the SDK event PID lock only while holding that lock. The first live sequence recovered after the corrected image was started and passed all subsequent checks/restores. A second complete live sequence then passed independently from the corrected image, including backup recovery, full checks, both snapshot restores, pruning and post-prune restoration.

The final local OCI manifest contains both linux/amd64 and linux/arm64. Compose startup with `--wait`, its healthcheck, restart/session reuse and refusal of a concurrent container were also verified. Both architecture images build and execute; neither contains restic. The arm64 container has also created a live Proton repository, backed up three files (1 MiB logical), passed a full data check, and restored and compared those files under QEMU.

Run the live fault sequence only against a dedicated disposable repository/container:

```sh
LIVE_DISPOSABLE=1 \
STRESS_CONTAINER=your-disposable-container \
REST_TOKEN_FILE=/private/token \
RESTIC_PASSWORD_FILE=/private/restic-password \
RESTIC_REPOSITORY=rest:http://127.0.0.1:18000/ \
RESTIC_BIN=/path/to/restic \
python3 scripts/live-container-stress.py
```

The container must be on Docker's `bridge` network and already authenticated/configured. It is paused, disconnected, killed and restarted by name. Add `SKIP_INIT=1` to use an initialized test repository. Each run tags its snapshots uniquely and prunes only its baseline snapshot. `scripts/fault-test.py` supplies additional live object-level upload/disconnect/retry/range/delete checks.

Earlier independent recovery validation downloaded the repository with the official CLI's unmodified filesystem-download implementation, converted the flat pack directory to local restic shards, and passed plain-restic full checking and restoration without the adapter or cache. See [operations.md](operations.md).

## Continuous integration

Every push and pull request runs type checks, the unit/integration suite and the real-restic fault test. Successful tests gate Docker builds and runtime smoke tests for amd64 and arm64. Pushes publish a multi-platform GHCR image tagged by branch and commit; the default branch also updates `latest`. CI does not contain Proton credentials or call the live account.

## Boundaries

These checks establish observed behavior, not a guarantee against every storage failure. Backend 503s, corruption and version mismatches are injected at the SDK boundary; live tests do not control Proton's servers. Token refresh is tested against a local account-API fixture, while real login/session reuse are tested against Proton. Multi-day real token refresh, service migrations, physical power loss, quota-accounting delays, multi-terabyte repositories, and physical ARM hardware remain untested. Keep independent copies of the repository password and exercise actual recovery periodically.
