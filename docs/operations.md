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
| `PROTON_DRIVE_CACHE_DIR` | `/state` | Encrypted session, SDK caches, verified packs, repository UID, token and deletion intent |
| `REPOSITORY_UID` | `/state/repository.uid` contents | Select an existing dedicated Drive folder |
| `REST_TOKEN_FILE` | `/state/rest-token` | Basic authentication password (username `backup`) |
| `HOST` | `0.0.0.0` | Listener address; source execution defaults to loopback |
| `PORT` | `8000` | Listener port |
| `SESSION_KEY_FILE` | `/run/secrets/session-key` | External file containing a 32-byte key encoded as 64 hexadecimal digits |
| `PACK_CACHE_MIB` | `256` | Verified pack cache capacity; `0` disables caching |
| `PROTON_DRIVE_CREDENTIALS_STORE` | `unsafe_file` | Upstream setting name; this application encrypts that file. Source installs can use `pass` or OS keychain |

## Headless login with 2FA

Run `docker compose run --rm drive login --headless` over SSH. Open its URL in a browser on another device and finish Proton's account login and second-factor challenge there. The official SDK uses an encrypted session-fork approval protocol: the server polls Proton for completion. It does not launch a server-side browser, bind a callback port, or require a redirect URL to be pasted. Keep the terminal command running until it prints `Signed in.`; the SDK waits up to ten minutes. A stale approval URL requires a new login command. Treat that URL as sensitive and do not share it.

`login` without arguments uses the same browser flow. `login username` is the single-password alternative and does not implement an inline OTP prompt. Stop the server before reauthenticating so the state lock is available.

## Session encryption and migration

Sessions, including access/refresh tokens and the Drive user-key password, are stored using authenticated AES-256-GCM encryption. The master key is mounted separately from the state volume as a Docker secret. Missing/incorrect keys, damaged ciphertext and unsupported envelope versions fail closed. Refreshed sessions are encrypted and atomically persisted with fsync.

For an existing installation, stop the old server, keep the volume, update Compose and create the key before starting the new image:

```sh
docker compose down  # retain volumes; do not use -v
chmod 700 .
# Create once. Do not overwrite an existing key.
(test -e session-key || (umask 077; openssl rand -hex 32 > session-key))
chmod 644 session-key
curl -fsSLO https://raw.githubusercontent.com/FarisZR/restic-proton-drive/main/compose.yaml
docker compose pull
docker compose up -d --wait
```

The deployment directory is mode 0700 to restrict host access. The key file is mode 0644 so the non-root container can read the bind-mounted secret even when the host login UID differs from 1000. Keep that directory private. Compose mounts only the key file read-only. Other secret-management systems can mount their own key and set `SESSION_KEY_FILE` instead.

On first startup, a valid legacy plaintext session is atomically replaced by an encrypted envelope; no plaintext backup file is created. Previously copied volumes/backups can still contain old plaintext credentials. Keep the key outside state-volume backups. Encryption protects a copied state volume; it does not protect a compromised running host/container with access to the mounted key. The REST authentication token remains a protected mode-0600 file. Restic's encryption password is separate and never stored by this server.

If the key is lost, restore it or remove only `auth-session.json` and the two SDK cache SQLite files (including WAL/SHM files) while the server is stopped, then authenticate again with a new key. Keep `repository.uid`, `rest-token`, and deletion journals. Independent recovery of the repository still needs only Proton authentication and the restic repository password.

`create` makes a dedicated repository folder, saves its UID, and generates the REST token. It refuses to replace an already configured repository. It does not generate or retain a restic password. If supplying `REPOSITORY_UID` manually, supply `REST_TOKEN_FILE` too.

The Docker healthcheck reports whether authenticated HTTP requests can be processed; it bypasses transfer admission and storage work. It does not certify that Proton is reachable or that a backup is restorable. Monitor restic command exit codes and schedule full content checks and periodic restores. HTTP operations have a 30-minute deadline; disconnected clients abort the associated SDK transfer. A failed transfer must be retried by the client. The SDK applies its own network retry/backoff policy.

## Updates and compatibility

The SDK, Bun and dependencies are pinned. Proton requirement headers that demand a newer SDK or unsupported Drive features fail the operation. Unsupported REST protocol versions return 406. New restic releases should pass the test suite before changing the supported version. Both REST v1/v2 are supported; repository config remains immutable, so in-place repository-format migration is not supported.

Use a single adapter process and persistent volume per repository, and avoid modifying the repository through other Drive clients. Four transfers can run concurrently; excess requests receive 503 with retry guidance. Mutations are serialized inside the store to protect immutable objects and the deletion journal. Multiple restic clients can use the server; restic's own locks coordinate backup and maintenance. Run retention and checks according to your operational schedule.

Keep pending deletion journals. Deletion first records an exact UID durably, then trashes and permanently deletes that node. Restart finishes any pending deletion. Losing the journal during a deletion can leave an orphan in Trash. Never empty the whole account's Trash as a repair shortcut. A moved deletion target requires manual review.

## Lookup index and verified pack cache

Point lookups use an in-memory name-to-UID index built from one complete SDK traversal per directory. Successful uploads and deletions update it immediately. Drive events update changed nodes, invalidate it on refresh/errors, and keep SDK caches synchronized. Restart rebuilds it rather than trusting a persisted object catalog. Every REST listing still performs a complete SDK traversal and fails if any page/metadata entry fails; pruning never relies solely on the point-lookup index.

Only partial pack reads use the disk cache. Concurrent requests for the same pack share one full, verified download. Entries are content-addressed, checked for length and SHA-256 on every use, evicted by LRU, and pinned while a response streams. A canceled waiter cannot abort another waiter's download. Cache capacity includes in-flight and pinned entries; a full pinned cache returns 503. Packs larger than the configured cache bypass it.

Full GETs, ranges covering the whole object, and upload read-back verification always read Proton. Consequently `restic check --read-data` cannot succeed just because a good local cached copy masks remote damage or loss. Partial reads can reuse the previously verified immutable content. The first partial read still downloads the entire pack to retain full SDK verification. Cache hits save network bandwidth; they still hash local file contents. Restart discards the cache. `PACK_CACHE_MIB=0` restores uncached operation.

The default cache is 256 MiB. Four admitted transfers use at most 512 MiB of temporary files in addition to that cache; no full repository mirror is kept. The repository layout is unchanged, so existing repositories need no migration.

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
