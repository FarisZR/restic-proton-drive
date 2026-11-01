# Operations and recovery

## Image and configuration

The image contains only Bun and the bundled REST server, including its login and folder-creation commands. It runs as UID 1000. Restic is a separate client. The supported Linux platforms are amd64 and arm64; Bun does not support 32-bit ARM.

Compose uses a private named volume and publishes port 8000 on host loopback. Inside the container the listener binds to all interfaces so Docker networking can reach it. Do not expose the unencrypted HTTP port over the public internet. Use an SSH tunnel or authenticated TLS termination for remote clients.

| Setting | Default in image | Purpose |
| --- | --- | --- |
| `PROTON_DRIVE_CACHE_DIR` | `/state` | Persistent session, encrypted SDK caches, repository UID, token and deletion intent |
| `REPOSITORY_UID` | `/state/repository.uid` contents | Select an existing dedicated Drive folder |
| `REST_TOKEN_FILE` | `/state/rest-token` | Basic authentication password (username `backup`) |
| `HOST` | `0.0.0.0` | Listener address; source execution defaults to loopback |
| `PORT` | `8000` | Listener port |
| `PROTON_DRIVE_CREDENTIALS_STORE` | `unsafe_file` | Container uses a private file; source installations can select upstream `pass` or OS keychain |

The file credential store name comes from the upstream CLI. In the image, the session is stored in a mode-0600 file in the private volume. Treat the volume as credentials. Session writes use atomic rename and fsync, including refreshed tokens. Host disk encryption can protect it at rest. No external keyring, browser installation, Bun installation, or package download is needed inside a running container. Browser login can be completed on another device.

`create` makes a dedicated repository folder, saves its UID, and generates the REST token. It refuses to replace an already configured repository. It does not generate or retain a restic password. If supplying `REPOSITORY_UID` manually, supply `REST_TOKEN_FILE` too.

The Docker healthcheck reports whether the authenticated REST request queue can respond. It does not certify that Proton is reachable or that a backup is restorable. Monitor restic command exit codes and schedule full content checks and periodic restores. HTTP operations have a 30-minute deadline; disconnected clients abort the associated SDK transfer. A failed transfer must be retried by the client. The SDK applies its own network retry/backoff policy.

## Updates and compatibility

The SDK, Bun and dependencies are pinned. Proton requirement headers that demand a newer SDK or unsupported Drive features fail the operation. Unsupported REST protocol versions return 406. New restic releases should pass the test suite before changing the supported version. Both REST v1/v2 are supported; repository config remains immutable, so in-place repository-format migration is not supported.

Use a single adapter process and persistent volume per repository, and avoid modifying the repository through other Drive clients. Multiple restic clients can use the server; restic's own locks coordinate backup and maintenance. Run retention and checks according to your operational schedule.

Keep pending deletion journals. Deletion first records an exact UID durably, then trashes and permanently deletes that node. Restart finishes any pending deletion. Losing the journal during a deletion can leave an orphan in Trash. Never empty the whole account's Trash as a repair shortcut. A moved deletion target requires manual review.

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
