# restic-proton-drive

Store a restic repository in Proton Drive. The Docker image runs the REST server; use your own restic client (tested with **0.19.1**). Supports **amd64 and arm64**.

## Start

```sh
git clone --recurse-submodules https://github.com/FarisZR/restic-proton-drive.git
cd restic-proton-drive
docker compose build
docker compose run --rm drive login
docker compose run --rm drive create backups
docker compose up -d --wait
```

Open the login URL in your browser. For accounts without 2FA, `login your-username` also accepts a hidden password prompt.

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

The `drive-state` Docker volume keeps your Proton session, server token, caches and pending deletions across restarts. Keep it private and retain it when updating. The server is published only on localhost. For a restic client in another container, join the Compose network and use `rest:http://drive:8000/`.

Use restic's default pack size. The server accepts objects up to 64 MiB and uses at most 128 MiB of temporary transfer files, plus metadata caches. Run one server per repository and manage its files through restic.

## Update and maintain

```sh
git pull --recurse-submodules
docker compose up -d --build --wait
# Choose retention to suit your backups:
restic forget --keep-daily 7 --keep-weekly 4 --prune
restic check --read-data
```

Every push builds amd64/arm64 images at `ghcr.io/fariszr/restic-proton-drive`, tagged by branch and commit; `latest` follows the default branch. You can replace `build: .` in Compose with that image.

[Recovery and configuration](docs/operations.md) · [Design and project context](docs/design.md) · [Tests and reliability limits](docs/testing.md)
