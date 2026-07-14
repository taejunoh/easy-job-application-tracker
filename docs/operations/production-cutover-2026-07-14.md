# Production Cutover Evidence — 2026-07-14

This record contains sanitized release evidence only. It intentionally excludes
credentials, environment values, local account paths, user content, encrypted
payloads, and request or database row bodies.

## Release identity

| Item | Evidence |
| --- | --- |
| Source `main` commit | `81726516536de42eab9b79d3b0fd386174d1b39f` |
| Promoted Vercel deployment | `dpl_CvkRMZ6whKdVtSnRULs1Bc5e4sND` |
| Previous hardened rollback deployment | `dpl_4otsKDgmnQYatFYDE1je87MsvuAm` |
| Migration baseline | `20260713000000_init` |
| Verified pre-cutover backup SHA-256 | `d8d814866cc51d7fbcea9cbe206be33f1fff683d514134358801bf0e351f56ec` |

## Data preservation

Counts were compared before the baseline, after the baseline, and after
promotion. No production row content was recorded.

| Relation | Before | After baseline | After promotion |
| --- | ---: | ---: | ---: |
| `Application` | 153 | 153 | 153 |
| `Settings` | 1 | 1 | 1 |
| `_prisma_migrations` | 0 | 1 | 1 |

The backup checksum verified successfully, a scratch restore completed without
error, and the approved source and restored fingerprints matched. After
baselining, migration status reported one finished, non-rolled-back migration;
the schema diff was empty and application/settings fingerprints were unchanged.
The final expected production state is 153 Applications, 1 Settings row, and 1
migration record (153/1/1).

## Status matrix

| Check | Expected | Result |
| --- | --- | --- |
| Candidate deployment | Ready | Pass |
| Unauthenticated Applications read | 401 | Pass |
| Invalid authentication | 401 | Pass |
| Unapproved Origin | 403 | Pass |
| Authenticated Applications read | 200 and 153 rows | Pass |
| Authenticated Settings metadata read | 200 and configured | Pass |
| Canonical-origin preflight | 204 | Pass |
| Browser session flow | Authenticated read succeeds | Pass |
| Application create/update/delete smoke | Smoke row removed | Pass |
| Chrome extension pairing and save | Authenticated operation succeeds | Pass |
| Production release logs | No cutover-related 5xx | Pass |
| Public alias | Promoted deployment ID | Pass |

## Rollback evidence

The previous hardened deployment is the application rollback target listed
above. A deployment rollback must be followed by the same authentication,
Origin, session, extension, and log checks in the status matrix. The older
unauthenticated legacy release is not an acceptable public rollback target.

For database recovery, use the verified backup identified by the recorded
SHA-256 or the managed PostgreSQL recovery history. Restore into an isolated
target, verify 153/1/1 plus schema and fingerprint parity, then switch the
application through a controlled deployment. Never overwrite the active
database in place or edit migration history manually.

Operational procedures and recovery objectives are maintained in
[production-runbook.md](production-runbook.md).

## Post-merge validation

Pull request `#2` merged as `a63a34e3b12f42321ccb503c9ac9bfee6ba91ad9`.
The corresponding Production deployment `dpl_DcT27ETzHxCFSGxLxrdkZy74d6Pg`
reached Ready and owns the canonical alias. Main-branch CI run `29367784093`
passed both verification and bundled-Chromium extension jobs. Manual Production
monitor run `29367974975` passed, and encrypted backup run `29367976135`
completed source snapshot, scratch restore, fingerprint comparison, encryption,
upload, and cleanup.

The uploaded backup was downloaded through the authenticated operator channel.
Its encrypted checksum, age decryption, manifest plaintext checksum, PostgreSQL
17 table of contents, isolated restore, UTC fingerprint, and 153/1/1 counts all
verified. Only the encrypted artifact remains under the 30-day GitHub retention
policy; the local decrypted verification files and scratch database were
removed.
