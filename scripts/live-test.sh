#!/usr/bin/env bash
# Run against a disposable repository with the adapter already listening.
set -euo pipefail
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD_FILE:?}" "${RESTIC_REST_PASSWORD:?}"
export RESTIC_REST_USERNAME=backup
restic_bin=${RESTIC_BIN:-restic}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export RESTIC_CACHE_DIR="$work/cache"
mkdir "$work/source"
printf 'first version\n' > "$work/source/document"
head -c 1048576 /dev/urandom > "$work/source/random"
"$restic_bin" version
if [[ ${SKIP_INIT:-0} != 1 ]]; then "$restic_bin" init; fi
"$restic_bin" backup "$work/source" --tag first
printf 'second version\n' > "$work/source/document"
"$restic_bin" backup "$work/source" --tag second
"$restic_bin" check --read-data
rm -rf "$RESTIC_CACHE_DIR"
"$restic_bin" restore latest --target "$work/restore"
diff -r "$work/source" "$work/restore$work/source"
"$restic_bin" forget --keep-last 1 --group-by '' --prune
"$restic_bin" check --read-data
printf 'Live backup, incremental backup, cold-cache restore and prune passed.\n'
