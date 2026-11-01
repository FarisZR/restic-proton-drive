# restic-proton-drive

Store a restic repository in Proton Drive. The Docker image runs the REST server; use your own restic client (tested with **0.19.1**). Supports **amd64 and arm64**.

## Start

```sh
mkdir -m 700 restic-proton-drive && cd restic-proton-drive
openssl rand -hex 32 > session-key
chmod 644 session-key
curl -fsSLO https://raw.githubusercontent.com/FarisZR/restic-proton-drive/main/compose.yaml
docker compose pull
docker compose run --rm drive login --headless
docker compose run --rm drive create backups
docker compose up -d --wait
```

Open the URL on your laptop or phone and complete login, including 2FA. Keep the terminal running; no browser or redirect listener is needed on the server. Accounts without 2FA can also use `login your-username` with a hidden password prompt.

Configure restic in your shell:

```sh
export RESTIC_REPOSITORY=rest:http://127.0.0.1:8000/
export RESTIC_REST_USERNAME=backup
export RESTIC_REST_PASSWORD="$(docker compose run --rm --entrypoint cat drive /state/rest-token)"
export RESTIC_PASSWORD_FILE=/secure/path/to/your-restic-password

restic init
restic backup /path/to/data
restic check --read-data
restic restore latest --target /path/to/restore
```

Create and keep a secure copy of your restic password before initializing. It is separate from your Proton password and is required for recovery.

Keep `session-key` in this private deployment directory, outside the `drive-state` volume. It encrypts the Proton session; Compose mounts it as a secret. Retain both the key and volume across updates. The server is published only on localhost. For a restic client in another container, join the Compose network and use `rest:http://drive:8000/`.

Use restic's default pack size. The server accepts objects up to 64 MiB and uses a bounded 256 MiB verified-pack cache and up to 512 MiB of temporary transfer files, plus metadata caches. Run one server per repository and manage its files through restic.

## Update and maintain

Upgrading an older install? [Add the session encryption key first](docs/operations.md#session-encryption-and-migration).

```sh
docker compose pull
docker compose up -d --wait
# Choose retention to suit your backups:
restic forget --keep-daily 7 --keep-weekly 4 --prune
restic check --read-data
```

Every push builds amd64/arm64 images at `ghcr.io/fariszr/restic-proton-drive`, tagged by branch and commit; `latest` follows the default branch. For a fixed deployment, pin the image to a commit tag or digest.

[Recovery and configuration](docs/operations.md) · [Design and project context](docs/design.md) · [Tests and reliability limits](docs/testing.md)
