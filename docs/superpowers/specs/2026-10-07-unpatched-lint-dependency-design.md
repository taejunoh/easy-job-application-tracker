# Unpatched Lint Dependency Remediation — Approved Design

Status: approved by the user on 2026-10-07 after explanation of the restricted pattern contract and local maintenance responsibility. Ordinary patch-version updates are complete; implement this restricted design without weakening the audit.

## Goal and constraints

Remove the unpatched `braces` and `sprintf-js` dependency paths while preserving the application's existing lint rules and leaving the security gate unchanged. Do not force incompatible peers, suppress advisories, relabel vulnerable code, or introduce an audit exception. Hosted production and user data remain out of scope.

## Alternatives

1. Conditional recommendation: retain the upstream Next ESLint plugin and all existing rules; replace only its directory-discovery dependency with an explicitly named, narrowly scoped adapter using maintained glob tooling. Support the default root, literal directory paths and simple single-segment `*` monorepo patterns such as `packages/*`. Reject advanced glob syntax. This preserves this repository's existing default-root lint behavior, but is **not universal fast-glob compatibility**. It introduces a local maintenance responsibility and requires real rule-level tests plus explicit acceptance of that narrower configuration contract.
2. Wait for official upstream releases, retaining the honest audit and merge failure. No maintained official patched release for the two dependency paths was found during the 2026-10-07 review.
3. A full Next ESLint plugin fork is not recommended: it would copy roughly 56 files / 106 KB, require manually tracking future rule updates, and would not itself solve the replacement matcher's semantic differences.

## Components and behavior

- `tools/next-root-glob/`: private CommonJS package named `@jobtracker/next-root-glob`, with its purpose, upstream consumer and non-drop-in scope documented. It supports only the actual pinned Next consumer's `globSync(stringPattern, { onlyDirectories: true })` contract and rejects array arguments and unsupported API/options. Next itself converts rootDir setting arrays into individual string calls. With the current default setting it uses `context.cwd` directly and does not call this adapter.
- A scoped npm override replaces `fast-glob` only for the exact reviewed `@next/eslint-plugin-next` version. The replacement must actually remove `fast-glob → micromatch → braces` from the installed and locked dependency graph. No unrelated consumer is redirected.
- Install the honestly named private adapter from the committed relative tarball `tools/vendor/jobtracker-next-root-glob-1.0.0.tgz`. A directory `file:` reference was experimentally found to become a dangling consumer-relative link in npm 10 and npm 12. The tarball preserves the same scoped `$@jobtracker/next-root-glob` override and works with normal npm 10 installation after relocation and with an empty cache. Allow only `package.json`, `index.cjs` and `README.md` in the archive; require deterministic repacking byte parity and installed-source parity. Do not use lifecycle patching, an absolute path, registry publication or a misleading upstream identity.
- The adapter uses `tinyglobby@0.2.17` with `expandDirectories: false`. It preserves semantic root discovery for relative/absolute literal paths and patterns where a complete path segment is `*`. Globstar, brace alternatives, extglob, brackets, negative patterns and escape syntax are rejected before matching. A public parser's flags plus a narrow segment allowlist enforce that contract; no full custom glob parser, pattern-rewriting heuristic or brace-expansion implementation is allowed.
- Directory-result equivalence is required for the supported contract; harmless lexical normalization is acceptable only where tests prove that the real Next rule discovers the same pages. Pattern support is documented and unsupported cases fail closed rather than silently broadening lint behavior. Native platform path separators require explicit tests/handling rather than treating Windows separators as arbitrary escapes.
- Preserve wildcard-selected directory-symlink aliases with tinyglobby's public `fs.readdirSync` hook: classify only symlinks to directories with `statSync`, leaving ordinary entries and file/broken symlinks unchanged. Do not add a custom traversal or realpath deduplication. Test finite wildcard depth with cyclic aliases. Reject `.` or `..` segments after the first complete `*` segment: tinyglobby otherwise normalizes patterns such as `*/../*` into a broader match than the original. Leading `./` and `../`, and dot-segments in entirely literal paths, remain supported. This is an explicit fail-closed clarification of the restricted contract, not a generic compatibility claim.
- A separate scoped override moves `@istanbuljs/load-nyc-config@1.1.0` to `js-yaml@4.3.2`. Its only YAML API use is `.load`; compatible normal nyc configuration and intentional v4 unsafe-tag rejection must be tested.
- The existing ESLint 9 configuration remains. Its current security findings are transitive through `brace-expansion`, not an own ESLint advisory; ordinary compatible patches address that path.

## Required proof

1. Capture golden directory-discovery fixtures from the original installed `fast-glob`, then compare result sets for `.`, literal paths, single-segment wildcards, absolute paths, symlinks and missing paths. Exercise rootDir arrays through Next and reject array arguments passed directly to the adapter. Explicitly test rejection of globstar, brace alternatives, extglob, brackets, negative patterns and escapes. Record the known counterexamples (`src/**`, `src/{**,lib}`, `src/!(lib)/**`) so a future change cannot reintroduce a false generic-compatibility claim.
2. Exercise the actual Next `no-html-link-for-pages` rule with default, string, array and glob root settings. Preserve representative React hooks, JSX accessibility, TypeScript and Next lint errors.
3. Verify the pinned consumer still uses only the supported API/options; a future consumer/version change must require explicit review.
4. Bound hostile nested-brace input in a child-process regression and verify errors do not hang or overflow the stack.
5. Test `.yml` / `.yaml`, extends, arrays, booleans, thresholds and paths through the real nyc loader, plus documented unsafe-tag rejection.
6. Prove clean `npm ci` without peer bypass, actual removal of the vulnerable dependency nodes, full and production audits, unchanged audit-policy tests, lint, typecheck, full tests, production build and fresh Docker onboarding.

Only after the actual audit is clean may the existing empty exception policy's review dates be renewed with a recorded review. Keep PR #12 draft while any relevant gate fails; this design does not itself authorize main merge or production deployment.

## Research outcome

The actual published `tinyglobby@0.2.17` was evaluated without installing it into the checkout. The generic trailing-globstar rewrite failed for extglob prefixes, and brace/globstar combinations differed independently. Therefore the earlier generic-adapter proposal is withdrawn. Implement only the restricted contract above if the user accepts it; otherwise keep the honest audit failure and wait for an upstream fix.
