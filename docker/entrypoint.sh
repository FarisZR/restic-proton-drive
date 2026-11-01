#!/bin/sh
set -eu
case "${1:-serve}" in
  health|version) exec bun /app/app.js "$@" ;;
esac
# The kernel lock works across PID namespaces and is released after SIGKILL.
if [ "${ADAPTER_LOCK_HELD:-}" != 1 ]; then
    export ADAPTER_LOCK_HELD=1
    exec flock --exclusive --nonblock --no-fork "$PROTON_DRIVE_CACHE_DIR/adapter.lock" "$0" "$@"
fi
# The upstream event provider has its own PID lock. Replace it only while
# holding the kernel lock; container PID reuse otherwise blocks a restart.
rm -f "$PROTON_DRIVE_CACHE_DIR/events.lock"
exec bun /app/app.js "$@"
