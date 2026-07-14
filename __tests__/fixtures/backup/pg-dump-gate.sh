#!/bin/sh
set -eu

: "${REAL_PG_DUMP:?}"
: "${PG_DUMP_READY_FILE:?}"
: "${PG_DUMP_CONTINUE_FILE:?}"

: > "$PG_DUMP_READY_FILE"
while test ! -e "$PG_DUMP_CONTINUE_FILE"; do
  sleep 0.01
done

exec "$REAL_PG_DUMP" "$@"
