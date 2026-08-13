# Quarantine Operations Runbook

This runbook is the operator authority for inspecting, applying, reconciling,
recovering, validating, retaining, and restoring a numbered-copy quarantine.
Use only the canonical `npm run cleanup:quarantine -- ...` commands below.

The quarantine lifecycle is lossless. Validation retention is not deletion,
and `deleteAfter` is the earliest review time for a separately approved
destructive process. No purge command exists in this program.

## Safety boundary

Set these variables to absolute, NFC-normalized paths. `$QUARANTINE_ROOT` must
already exist outside `$REPO_ROOT`, be mode `0700`, and be on the same
filesystem as the repository.

```sh
export REPO_ROOT="$(git rev-parse --show-toplevel)"
export QUARANTINE_ROOT="/absolute/external/quarantine-root"
export EXPECTED_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD)"
export EXPECTED_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
export EXPECTED_COUNT="76"
export TRANSACTION_ID="operator-20260813-0001"
```

Before any command that accepts `--writers-stopped`, stop every process that
can write the repository or quarantine root: development servers, builds,
tests, editors with save actions, package managers, cleanup jobs, and other
quarantine operators. The flag is an operator attestation that both trees are
stable. For `reconcile`, it authorizes only a coherent read-only snapshot; it
does not authorize mutation, lock reclamation, journal append, or cleanup.

Never use `git clean`, manual payload movement, journal editing, or retention
auto-delete. Never delete or rewrite a manifest, pointer, inventory, lock,
conflict, rollback, or payload path. If evidence is missing, torn, malformed,
or contradictory, stop and preserve it.

## Canonical commands and flags

Every flag shown for a command is required. Duplicate, unknown, relative,
missing, non-normalized, or malformed values are rejected.

| Command | Required flags | Mutation |
| --- | --- | --- |
| `inspect` | `--repo-root`, `--quarantine-root`, `--expected-branch`, `--expected-head`, `--expected-count` | No |
| `apply` | all `inspect` flags, plus `--transaction-id`, `--writers-stopped` | Yes |
| `reconcile` | `--repo-root`, `--quarantine-root`, `--transaction-id`, `--writers-stopped` | No |
| `recover` | `--repo-root`, `--quarantine-root`, `--transaction-id`, `--action resume\|rollback`, `--writers-stopped` | Yes |
| `mark-validated` | `--repo-root`, `--quarantine-root`, `--transaction-id`, `--writers-stopped` | Yes |
| `restore` | `--repo-root`, `--quarantine-root`, `--transaction-id`, `--writers-stopped` | Yes |

```sh
npm run cleanup:quarantine -- inspect \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --expected-branch "$EXPECTED_BRANCH" \
  --expected-head "$EXPECTED_HEAD" \
  --expected-count "$EXPECTED_COUNT"

npm run cleanup:quarantine -- apply \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --expected-branch "$EXPECTED_BRANCH" \
  --expected-head "$EXPECTED_HEAD" \
  --expected-count "$EXPECTED_COUNT" \
  --transaction-id "$TRANSACTION_ID" \
  --writers-stopped

npm run cleanup:quarantine -- reconcile \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --transaction-id "$TRANSACTION_ID" \
  --writers-stopped

npm run cleanup:quarantine -- recover \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --transaction-id "$TRANSACTION_ID" \
  --action resume \
  --writers-stopped

npm run cleanup:quarantine -- recover \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --transaction-id "$TRANSACTION_ID" \
  --action rollback \
  --writers-stopped

npm run cleanup:quarantine -- mark-validated \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --transaction-id "$TRANSACTION_ID" \
  --writers-stopped

npm run cleanup:quarantine -- restore \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --transaction-id "$TRANSACTION_ID" \
  --writers-stopped
```

`apply` first flushes one `STARTING` JSONL record to stdout. Capture that line
in a mode-`0600` operator log outside the repository. The transaction ID from
the flushed STARTING record is the sole durable input for every later
recovery, reconciliation, validation, or restore command. Do not invent a
replacement ID from directory contents or partial output.

## JSONL records

Success records are one compact JSON object per stdout line. Failures are one
compact JSON object on stderr and never include paths, entry IDs, secrets, or
raw evidence. `apply` is the only command that emits two success records.

| Command | Success record |
| --- | --- |
| `inspect` | `{"ok":true,"command":"inspect","status":"INSPECTED","schemaVersion":2,...}` |
| `apply`, before mutation | `{"ok":true,"command":"apply","status":"STARTING","schemaVersion":2,"transactionId":"..."}` |
| `apply`, terminal | `{"ok":true,"command":"apply","status":"QUARANTINED","schemaVersion":1|2,...}` |
| `reconcile` | `{"ok":true,"command":"reconcile","schemaVersion":1,"state":"...","complete":false|true,"nextAction":"..."}` |
| `recover` | `{"ok":true,"command":"recover","result":{"schemaVersion":1|2,...}}` |
| `mark-validated` | `{"ok":true,"command":"mark-validated","status":"VALIDATED","schemaVersion":1|2,...}` |
| `restore` | `{"ok":true,"command":"restore","status":"RESTORED","schemaVersion":1|2,...}` |
| any failure | `{"ok":false,"command":"...","code":"ERR_...","message":"..."}` on stderr |

The reconcile record uses its own output contract `schemaVersion: 1`; this is
independent of whether the durable quarantine evidence is lifecycle v1 or v2.
Torn, missing, or conflicting evidence produces `ERR_INTEGRITY` and never a
success record, `complete`, or recovery directive.

## Exit codes

| Exit | Meaning | Operator response |
| --- | --- | --- |
| `0` | The requested operation completed and stdout contains its JSONL record(s). | Follow the returned state or `nextAction`. |
| `1` | `ERR_INTERNAL`, an unexpected implementation or platform failure. | Preserve all output and evidence; escalate. |
| `2` | `ERR_USAGE` or `ERR_PREFLIGHT`. | Correct flags or root/repository preconditions, then rerun inspection. |
| `3` | `ERR_RECOVERY_REQUIRED`, `ERR_CONFLICT`, `ERR_INTEGRITY`, or `ERR_EXDEV`. | Stop. Reconcile only if evidence is intact; otherwise escalate without editing evidence. |
| `4` | `ERR_INDETERMINATE_JOURNAL_APPEND`. | Treat the transaction as uncertain. Preserve the STARTING ID, stop writers, and reconcile. |

## Reconciliation state matrix

`reconcile` validates root identity and containment, the callback-scoped run
capability, the complete journal hash chain, the selected manifest generation,
the current pointer rules, inventory evidence, and the state-specific physical
layout. It reads the snapshot twice to detect cooperative changes. It never
reclaims a lock, appends or truncates the journal, publishes a pointer, removes
a temporary, or moves a payload.

| State | `complete` | `nextAction` |
| --- | ---: | --- |
| `PREPARED` | `false` | `recover_required` |
| `MOVING` | `false` | `recover_required` |
| `VERIFYING` | `false` | `recover_required` |
| `ROLLING_BACK` | `false` | `recover_required` |
| `QUARANTINED` | `false` | `mark_validated` |
| `VALIDATED` | `false` | `retain_and_review` |
| `RESTORE_PREPARED` | `false` | `recover_required` |
| `RESTORING` | `false` | `recover_required` |
| `RESTORE_ROLLING_BACK` | `false` | `recover_required` |
| `RECOVERY_REQUIRED` | `false` | `recover_required` |
| `INCOMPLETE_CONFLICT` | `false` | `investigate_conflict` |
| `RESTORED` | `true` | `none` |
| `ROLLED_BACK` | `true` | `none` |

## Apply and recovery decision tree

1. Run `inspect` while the repository is quiet and verify the expected branch,
   HEAD, artifact count, identical-copy count, and divergent-copy count.
2. Stop all writers and persist the chosen transaction ID outside the
   repository with mode `0600` permissions.
3. Run `apply` once. Preserve both JSONL lines and stderr.
4. If `QUARANTINED` is emitted, run `reconcile`; continue only when it returns
   `mark_validated`.
5. If apply exits nonzero after STARTING, do not rerun apply and do not inspect
   the run directory manually. Run `reconcile` with the STARTING ID.
6. For `recover_required`, choose `recover --action resume` when the approved
   goal remains quarantine, or `recover --action rollback` when the approved
   goal is returning to the pre-apply layout. Reconcile again after recovery.
7. For `investigate_conflict` or `ERR_INTEGRITY`, preserve the complete roots
   and sanitized command output and escalate. No generic recovery command is
   authorized to overwrite a conflict.

## Regeneration and validation

After a reconciled `QUARANTINED` state, regenerate dependencies and build
outputs from checked-in sources; never copy them out of retained payloads.

```sh
cd "$REPO_ROOT"
npm ci
npx --no-install prisma generate
npm test -- --runInBand --no-cache
npm run lint -- --max-warnings=0
npm run typecheck
npm run build
npm run check:extension
```

Use the repository's documented non-secret validation environment. When every
required gate is green, stop writers again, reconcile, and run
`mark-validated`. Preserve its manifest digest, `validatedAt`, and
`deleteAfter`, then reconcile once more and require `retain_and_review`.

`VALIDATED` means regenerated evidence passed and the original payload remains
retained. It does not mean deletion is allowed. `deleteAfter` is the earliest
review time, exactly 96 hours after durable validation; it is not an expiry,
timer, scheduled cleanup, or authorization to delete. Retention auto-delete is
prohibited. Final deletion needs a separate destructive lifecycle design,
explicit confirmation, and a future operator runbook.

## Restore and restore recovery decision tree

1. Record the incident decision and stop writers.
2. Reconcile the STARTING transaction ID. Do not restore from
   `recover_required`, `investigate_conflict`, or `ERR_INTEGRITY` evidence.
3. From `QUARANTINED` or `VALIDATED`, run `restore` once.
4. If restore exits nonzero, reconcile. For `recover_required`, use
   `recover --action resume` to finish the durable restore or
   `recover --action rollback` to return to the stable quarantine layout.
5. Reconcile again. `RESTORED` or `ROLLED_BACK` with `complete:true` and
   `nextAction:"none"` is terminal. `INCOMPLETE_CONFLICT` requires isolated
   conflict investigation; do not move conflict or payload paths by hand.

Keep the external quarantine root and sanitized operator log intact until the
incident and retention review are formally closed.
