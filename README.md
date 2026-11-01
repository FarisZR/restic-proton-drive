# restic-proton-drive

A small, unofficial Restic REST backend using Proton's official Drive SDK. Targets **restic 0.19.1**, the latest release verified on 2026-11-01. No restic patches, rclone, mount, or local repository mirror.

This is a third-party application not officially supported by Proton. Proton currently permits personal experiments with the SDK; third-party production support is still pending. Its planned crypto migration will require SDK upgrades. See [Proton's SDK status and guidelines](https://github.com/ProtonDriveApps/sdk).

## Setup

Requires Linux, [Bun](https://bun.sh) >=1.4.2 (tested with 1.4.4), and [restic](https://github.com/restic/restic/releases/tag/v0.19.1) 0.19.1. The SDK is a pinned submodule; its CLI supplies authentication, refresh, encrypted caches, and event subscriptions. Dependencies use the public npm registry.

```sh
git clone --recurse-submodules https://github.com/FarisZR/restic-proton-drive.git
cd restic-proton-drive
bun install --frozen-lockfile

# Use a private, dedicated state directory for this process.
export PROTON_DRIVE_CACHE_DIR="$HOME/.local/state/restic-proton-drive"
mkdir -p "$PROTON_DRIVE_CACHE_DIR"
chmod 700 "$PROTON_DRIVE_CACHE_DIR"

# Linux servers: configure pass/GPG first, with unattended decryption available
# to the service user. The alternative default is the OS keychain.
export PROTON_DRIVE_CREDENTIALS_STORE=pass
bun start login
# Open the printed browser URL. For a single-password account without 2FA:
# bun start login your-username  (hidden password prompt)

bun start create backups
# Save the printed REPOSITORY_UID in your service environment.
export REPOSITORY_UID='paste-the-printed-UID'
export REST_TOKEN_FILE="$PROTON_DRIVE_CACHE_DIR/rest-token"
umask 077
openssl rand -hex 32 > "$REST_TOKEN_FILE"
openssl rand -hex 32 > "$PROTON_DRIVE_CACHE_DIR/repository-password"
bun start serve
```

The server binds to `127.0.0.1:8000`; set `PORT` to change the port. Run **one adapter per repository**, using the same state directory after restarts. A second process sharing the session directory is rejected. Give each repository its own new folder; do not edit it with other Drive clients while the adapter is running.

In another shell, set the matching paths and secrets:

```sh
export RESTIC_REPOSITORY=rest:http://127.0.0.1:8000/
export RESTIC_REST_USERNAME=backup
export RESTIC_REST_PASSWORD="$(cat "$REST_TOKEN_FILE")"
export RESTIC_PASSWORD_FILE="$PROTON_DRIVE_CACHE_DIR/repository-password"
restic init
restic backup /path/to/data
restic check --read-data
restic restore latest --target /path/to/restore
# Choose your retention policy before scheduling this:
restic forget --keep-daily 7 --keep-weekly 4 --prune
```

The REST token authenticates local HTTP requests. The repository password encrypts restic data and is separate from Proton credentials. Keep an independent recovery copy of that password. Session credentials stay in Proton's CLI credential store; they are never stored in git. `unsafe_file` is supported upstream for disposable tests only and was used in the private test state directory.

For unattended backups, run `bun start serve` as a service under the account that owns the credential store, with an absolute working directory and these environment variables. Restart on failure. Schedule ordinary restic commands only after the listener is ready, and alert on nonzero exits. The CLI persists and refreshes sessions; revoked sessions or an unavailable GPG/keychain need operator intervention. Long-duration refresh and reboot/keychain behavior have not yet been validated here.

## Storage behavior and limits

- Implements REST v1/v2 listing, initialization, stat, immutable writes, verified reads, byte ranges, and individual deletion. Whole-repository HTTP deletion is forbidden.
- One operation runs at a time, with at most eight requests admitted. Use restic's default pack size (16 MiB). Objects larger than **64 MiB** are rejected. A transfer uses a temporary file; an idempotent retry can use two files, at most **128 MiB** total, plus small SDK metadata/crypto caches. Restart removes stale transfer files.
- Request bodies are fully received before upload. SHA-256 must match the restic object name; the SDK also receives expected size and SHA-1. Success is returned only after SDK upload completion. Existing committed objects are compared against downloaded, verified bytes; a retry cannot overwrite them. Config is immutable too; in-place repository format migration is not supported.
- Downloads use the SDK's full verification path, including for ranges. The full object is downloaded and checked before sending any bytes. This favors integrity over bandwidth; small random reads can download a whole pack repeatedly. Node's HTTP server preserves the exact length required by restic 0.19.1.
- SDK events maintain its caches. Folder listings are scoped to the requested repository directory. Metadata/decryption failures, duplicate names, unknown entries, and missing sizes fail the operation instead of producing a partial successful listing. No recursive polling loop or separate object catalog.
- Deletion writes a durable local intent, trashes the exact node, then permanently deletes that node. On restart it finishes pending deletion before serving requests. It never empties the account's Trash. Keep the state directory: losing it during deletion can leave an orphan in Trash that needs manual cleanup. Moving a pending deletion target causes a hard failure for manual review.

The repository's `data` folder is flat, as exposed by the REST protocol. The other folders and `config` are ordinary restic objects. All repository content is restic-encrypted before the SDK adds Drive encryption.

## Independent recovery

Stop the adapter. Download its complete dedicated folder using the [official Proton Drive CLI](https://proton.me/download/drive/cli/index.html), or the Drive web client, to another machine:

```sh
proton-drive auth login
proton-drive filesystem download /my-files/backups ./recovery
```

Convert the flat REST data directory to restic's local layout (no content changes):

```sh
cd recovery/backups
python3 - <<'PY'
from pathlib import Path
for blob in Path('data').iterdir():
    if blob.is_file():
        shard = blob.parent / blob.name[:2]
        shard.mkdir(exist_ok=True)
        blob.rename(shard / blob.name)
PY
restic -r . check --read-data
restic -r . restore latest --target ../restored
```

Supply the original repository password. This restore uses only standard restic and the downloaded files; the adapter and its caches are not required.

## Validation

```sh
bun run check
bun run test
# DESTRUCTIVE: use a disposable repository with the server running.
# Supply RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE, RESTIC_REST_PASSWORD.
RESTIC_BIN=/path/to/restic scripts/live-test.sh
# Existing test repository: SKIP_INIT=1
REST_TOKEN_FILE=/private/path/to/token python3 scripts/fault-test.py
```

The live script keeps only the latest snapshot across all groups. Never run it against a real backup repository. The fault script temporarily uploads/deletes an 8 MiB random object.

See [TESTING.md](TESTING.md) for observed results and remaining limits.
