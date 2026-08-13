# Dependency audit review — 2026-08-13

The locked dependency graph was regenerated with Node 22.22.2 after the
supported direct upgrades:

- Next, `@next/env`, and `eslint-config-next`: 16.3.0
- Prisma, `@prisma/client`, and `@prisma/adapter-pg`: 7.9.1
- Undici: 7.29.0
- Root PostCSS: 8.5.26

Fresh `npm audit --json` and `npm audit --omit=dev --json` reports both contain
zero critical, high, moderate, and low findings. No audit exceptions remain;
`docs/operations/npm-audit-exceptions.json` is intentionally empty. The full
graph remains the blocking policy gate, and the production graph is reported
separately for deployment risk visibility.

## Enforcement

Run `npm run check:audit`. The checker validates both audit reports, review
dates, advisory mappings, and the exception set. It fails closed on malformed or
network-error output, any high or critical finding in either graph, unexpected
moderate or low findings, missing wrapper targets, stale exceptions, or expired
review dates. Output contains only graph severity and exception counts, never
dependency paths or audit input.

The lockfile must be regenerated with a Node 22 runtime in the supported range;
CI is pinned to Node 22.22.2. Do not use `npm audit fix --force` or downgrade the
supported Next or Prisma release lines.
