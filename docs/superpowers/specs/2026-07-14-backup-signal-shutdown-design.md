# Backup Signal Shutdown Design

## Goal

Make `create-snapshot-backup.mjs` handle `SIGINT` and `SIGTERM` without leaving a direct `pg_dump`, Docker-side `pg_dump`, open PostgreSQL transaction, service credential, or partial output behind. Cleanup must finish before the coordinator exits with status 130 or 143.

## Chosen design

A run-scoped signal controller installs listeners only while the backup is active. The first signal records the requested exit status and starts one idempotent interruption operation; later signals do not start another cleanup path. The controller tracks the currently active child and terminates its isolated process group with `SIGTERM`, waits for a bounded interval, and escalates to `SIGKILL` if it does not close.

Direct `pg_dump` runs in its own process group so wrappers and descendants cannot outlive the coordinator. Docker dumps use a random, non-secret pidfile beside the random service file. A container-side shell wrapper records the `pg_dump` PID and traps termination. On coordinator interruption, an explicit Docker cleanup command sends `SIGTERM` and then bounded `SIGKILL` to that PID/process group before the local Docker CLI is terminated. No database URI or password is placed in argv, child environment, logs, pidfiles, or Docker metadata.

The existing ownership layers remain authoritative: `dumpSnapshot` removes container and host service files, while `createSnapshotBackup` removes partial/final outputs and rolls back/ends the PostgreSQL client. The signal controller only stops active work; it does not duplicate resource cleanup. Signal listeners are removed after all cleanup, then the entry point exits with 130 for `SIGINT` or 143 for `SIGTERM`.

## Tests

- A real-process direct-mode integration test blocks the dump child, sends a signal, and proves the process group is gone, the coordinator session is closed, credentials and partial outputs are absent, and the exit status is conventional.
- A fake-Docker integration test models a long-running remote dump and pidfile. It proves explicit remote TERM/KILL, local Docker child closure, container/host credential and pidfile cleanup, partial-output removal, sanitized metadata, and the correct exit status.
- Existing snapshot consistency, direct failure, and Docker success/failure tests remain green.

## Alternatives rejected

- Relying on Node's default signal behavior skips asynchronous cleanup.
- Killing only the local `docker exec` process does not guarantee the container-side `pg_dump` exits.
- Performing all cleanup inside the signal handler duplicates existing `catch`/`finally` ownership and creates races.
