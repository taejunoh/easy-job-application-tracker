# Dependency audit review — 2026-10-21

Status: scheduled policy review. Full and production-classification audits of unchanged `main` source `d8c7954` report zero findings, so the policy review dates are renewed with zero exceptions. No dependency, lock or gate change was needed. This is an advisory-database snapshot, not a guarantee against unknown vulnerabilities.

## Evidence

- A fresh sequential `npm ci` on Node 22.22.2 succeeded before auditing.
- Raw `npm audit --json` (full graph) exited 0 with info/low/moderate/high/critical/total all zero.
- Raw `npm audit --omit=dev --json` returned an empty registry error on its first attempt and succeeded on retry with every severity and total at zero.
- Locally, the unchanged `npm run check:audit` failed twice without any blocked severity: its full-graph counts printed as zero, but both production-audit attempts exceeded the gate's 120 s per-attempt limit (runs took 240 s and 361 s) against a slow registry from this machine. The gate itself was not changed or bypassed; the PR's CI `verify` job runs it against the registry as the authoritative check.
- The unchanged gate was run against the saved raw reports through its fixture options (`--audit-file`, `--production-audit-file`, `--today`): before renewal it passed on 2026-10-21 and failed as expired on 2026-11-08; after renewal it passes through 2026-11-21 and fails as expired on 2026-11-22.

## Policy change

`docs/operations/npm-audit-exceptions.json` changes only `reviewedOn` to `2026-10-21` and `reviewBy` to `2026-11-21`. `schemaVersion: 1` and `exceptions: []` are unchanged. Without renewal, every CI run's `check:audit` step would fail as an expired policy from 2026-11-08.
