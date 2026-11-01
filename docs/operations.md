# Operations and recovery

## Image and configuration

The image contains only Bun and the bundled REST server, including its login and folder-creation commands. It runs as UID 1000. Restic is a separate client. Compose pulls the published GHCR image. To build from source instead:

```sh
git clone --recurse-submodules https://github.com/FarisZR/restic-proton-drive.git
cd restic-proton-drive
docker build -t ghcr.io/fariszr/restic-proton-drive:latest .
docker compose run --rm --pull never drive login --headless
docker compose run --rm --pull never drive create backups
docker compose up -d --pull never --wait
```

Source builds use the same session-key setup as the main README.

The supported Linux platforms are amd64 and arm64; Bun does not support 32-bit ARM.

Compose uses a private named volume and publishes port 8000 on host loopback. Inside the container the listener binds to all interfaces so Docker networking can reach it. Do not expose the unencrypted HTTP port over the public internet. Use an SSH tunnel or authenticated TLS termination for remote clients.

| Setting | Default in image | Purpose |
| --- | --- | --- |
| `PROTON_DRIVE_CACHE_DIR` | `/state` | Encrypted session, SDK caches, verified packs, repository UID, token |
| `REPOSITORY_UID` | `/state/repository.uid` contents | Select an existing dedicated Drive folder |
| `REST_TOKEN_FILE` | `/state/rest-token` | Basic authentication password (username `backup`) |
| `HOST` | `0.0.0.0` | Listener address; source execution defaults to loopback |
| `PORT` | `8000` | Listener port |
| `SESSION_KEY_FILE` | `/run/secrets/session-key` | External file containing a 32-byte key encoded as 64 hexadecimal digits |
| `AUDIT_UPLOADS` | `0` | Set `1` to download and verify every new committed upload; normal uploads trust SDK integrity checks and confirmed commit |
| `PACK_CACHE_MIB` | `256` | Verified pack cache capacity; `0` disables caching |
| `PROTON_DRIVE_CREDENTIALS_STORE` | `unsafe_file` | Upstream setting name; this application encrypts that file. Source installs can use `pass` or OS keychain |

## Headless login with 2FA

Run `docker compose run --rm drive login --headless` over SSH. Open its URL in a browser on another device and finish Proton's account login and second-factor challenge there. The official SDK uses an encrypted session-fork approval protocol: the server polls Proton for completion. It does not launch a server-side browser, bind a callback port, or require a redirect URL to be pasted. Keep the terminal command running until it prints `Signed in.`; the SDK waits up to ten minutes. A stale approval URL requires a new login command. Treat that URL as sensitive and do not share it.

`login` without arguments uses the same browser flow. `login username` is the single-password alternative and does not implement an inline OTP prompt. Stop the server before reauthenticating so the state lock is available.

## Session encryption

Sessions, including access/refresh tokens and the Drive user-key password, are stored using authenticated AES-256-GCM encryption. The master key is mounted separately from the state volume as a Docker secret. Missing/incorrect keys, damaged ciphertext and unsupported envelope versions fail closed. Refreshed sessions are encrypted and atomically persisted with fsync. Failed saves retain the new credentials in memory and retry in the background and before subsequent API requests/refresh shortcuts. A persistent storage failure is reported; new tokens cannot survive process loss until storage becomes writable and persistence succeeds.

The deployment directory is mode 0700 to restrict host access. The key file is mode 0644 so the non-root container can read the bind-mounted secret even when the host login UID differs from 1000. Keep that directory private. Compose mounts only the key file read-only. Other secret-management systems can mount their own key and set `SESSION_KEY_FILE` instead.

Keep the key outside state-volume backups. Encryption protects a copied state volume; it does not protect a compromised running host/container with access to the mounted key. The REST authentication token remains a protected mode-0600 file. Restic's encryption password is separate and never stored by this server.

If the key is lost, restore it or remove only `auth-session.json` and the two SDK cache SQLite files (including WAL/SHM files) while the server is stopped, then authenticate again with a new key. Keep `repository.uid`, `rest-token`, and the repository files. Independent recovery of the repository still needs only Proton authentication and the restic repository password.

`create` makes a dedicated repository folder, saves its UID, and generates the REST token. It refuses to replace an already configured repository. It does not generate or retain a restic password. If supplying `REPOSITORY_UID` manually, supply `REST_TOKEN_FILE` too.

The Docker healthcheck reports whether authenticated HTTP requests can be processed; it bypasses transfer admission and storage work. It does not certify that Proton is reachable or that a backup is restorable. Monitor restic command exit codes and schedule full content checks and periodic restores. HTTP operations have a 30-minute deadline. Cancellation reaches ID enumeration, transfers and their HTTP transport, including metadata methods without signal parameters. Metadata iteration drains outstanding SDK decrypt jobs before completing; the pinned SDK’s signaled mapper would abandon those jobs instead. Canceled queued mutations do not execute. Admission slots remain held until underlying work stops; uninterruptible SDK/cache or disk work can still delay cleanup. A failed transfer must be retried by the client. The SDK applies its own network retry/backoff policy.

## Updates and compatibility

The SDK, Bun and dependencies are pinned. Proton requirement headers that demand a newer SDK or unsupported Drive features fail the operation. Unsupported REST protocol versions return 406. New restic releases should pass the test suite before changing the supported version. Both REST v1/v2 are supported; repository config remains immutable, so in-place repository-format migration is not supported.

Use a single adapter process and persistent volume per repository, and avoid modifying the repository through other Drive clients. Five bulk transfers (matching restic’s default REST connection count) and two lock requests have separate admission limits. Lock writes/deletes use their own mutation queue, so bulk upload/verification cannot block lock refresh. Excess requests in a lane receive 503 with retry guidance. Multiple restic clients can use the server; restic's own locks coordinate backup and maintenance.

## Deletion and storage usage

Individual DELETE moves the exact repository object to Proton Trash. The server never permanently deletes committed objects or empties Trash. Retrying after a lost acknowledgment is safe: already-trashed objects are absent from the active directory. No local deletion journal is needed. The SDK can clean up its own unpublished upload drafts.

The REST credential still permits trashing repository objects, including snapshots/config; this is not append-only storage. A compromised backup client can therefore disrupt the active repository, but cannot use this server to purge its Trash. Recovery requires access to Proton. Restic encryption does not prevent authorized deletion.

Pruning now removes objects from the active repository but leaves them recoverable in Trash. Their storage can continue counting against quota. Clear unwanted Trash in Proton separately when appropriate; this service deliberately does not provide that operation.

## Upload acknowledgments

Incoming content-addressed objects must match their SHA-256 names. The SDK receives the exact byte count and SHA-1, verifies upload/block integrity and confirms the committed revision, including its own ambiguous-commit reconciliation. The adapter checks the returned revision metadata before acknowledging success. Normal uploads do not download their content again.

Set `AUDIT_UPLOADS=1` to add a full verified read-back of every new upload. Retrying a previously committed immutable object always verifies its actual existing content before acknowledging it, including config. Uncertain failures invalidate the local lookup index; retries reconcile against a complete listing and never overwrite an earlier object. Continue scheduling `restic check --read-data` (or rotating subsets) and restores to verify stored data over time.

## Lookup index and verified pack cache

Point lookups use an in-memory name-to-UID index built from one complete SDK traversal per directory. Successful uploads and deletions update it immediately. Drive events update changed nodes, invalidate it on refresh/errors, and keep SDK caches synchronized. Restart rebuilds it rather than trusting a persisted object catalog. Every REST listing explicitly enumerates child IDs, loads metadata in batches, and requires exactly one valid result per ID. Missing markers, omitted/duplicate/unexpected results, changed parents and undecryptable entries all fail the listing; pruning never relies solely on the point-lookup index.

Only partial pack reads use the disk cache. Concurrent requests for the same pack share one full, verified download. Entries are content-addressed, checked for length and SHA-256 on every use, evicted by LRU, and pinned while a response streams. A canceled waiter cannot abort another waiter's download. Cache capacity includes in-flight and pinned entries; a full pinned cache returns 503. Packs larger than the configured cache bypass it.

Full GETs, ranges covering the whole object, and optional upload audits always read Proton. Consequently `restic check --read-data` cannot succeed just because a good local cached copy masks remote damage or loss. Partial reads can reuse the previously verified immutable content. The first partial read still downloads the entire pack to retain full SDK verification. Cache hits save network bandwidth; they still hash local file contents. Restart discards the cache. `PACK_CACHE_MIB=0` restores uncached operation.

The default cache is 256 MiB. Five bulk and two reserved lock requests use at most 896 MiB of temporary files in addition to that cache; no full repository mirror is kept. The repository uses the standard Restic REST layout.

## Independent recovery

Stop the adapter. Download the repository's dedicated folder using the [official Proton Drive CLI](https://proton.me/download/drive/cli/index.html), or the Drive web client:

```sh
proton-drive auth login
proton-drive filesystem download /my-files/backups ./recovery
cd recovery/backups
```

The REST backend stores data packs in a flat folder. Convert that folder to restic's local layout without changing file contents:

```sh
python3 - <<'PY'
from pathlib import Path
for blob in Path('data').iterdir():
    if blob.is_file():
        shard = blob.parent / blob.name[:2]
        shard.mkdir(exist_ok=True)
        blob.rename(shard / blob.name)
PY
export RESTIC_PASSWORD_FILE=/secure/path/to/original-restic-password
restic -r . check --read-data
restic -r . restore latest --target ../restored --verify
```

The adapter, its token, and its caches are not needed for this restore. The original restic password is required.
