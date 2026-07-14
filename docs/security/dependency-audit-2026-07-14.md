# Dependency audit review — 2026-07-14

Node 22.22.2, exact supported direct dependency versions, and a non-force
lockfile remediation leave five moderate vulnerability paths, zero low, zero
high, and zero critical findings. The five paths resolve bidirectionally to two
concrete GitHub advisories in
`docs/operations/npm-audit-exceptions.json`. The exception review expires on
2026-08-14.

## Remaining upstream-pinned risk

- `GHSA-92pp-h63x-v22m` reaches `prisma` through `@prisma/dev` and
  `@hono/node-server`. The vulnerable static-file middleware belongs to the
  Prisma CLI toolchain and is not invoked by the deployed application. npm's
  proposed forced remediation downgrades Prisma 7.8.0 to 6.19.3, so all three
  direct Prisma packages remain aligned at 7.8.0 until a supported release
  carries `@hono/node-server` 1.19.13 or newer.
- `GHSA-qx2v-qp2m-jg93` reaches the Next wrapper through Next 16.2.10's private
  PostCSS 8.4.31 dependency. The application does not stringify
  attacker-controlled CSS. Root PostCSS is fixed at 8.5.19, but Next's private
  dependency is not overridden. Upgrade Next when a supported release bundles
  PostCSS 8.5.10 or newer; npm's forced Next 9.3.3 downgrade is rejected.

## Enforcement

Run `npm run check:audit`. The checker executes `npm audit --json`, validates
the report and review dates, resolves every wrapper path to concrete advisory
URLs, and requires the live and declared advisory sets and scopes to match in
both directions. It fails closed on malformed or network-error output, any
high or critical finding, unexpected moderate or low findings, missing wrapper
targets, stale exceptions, or expired review dates. Its output contains only
severity and exception counts, never dependency paths or audit input.

Do not run `npm audit fix --force`, downgrade Prisma or Next, or override their
private dependency graphs. Re-run non-force remediation and remove an exception
as soon as its stated supported upgrade condition is available.
