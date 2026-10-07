# Restricted Next root-directory glob adapter

This private, repository-maintained CommonJS package is **not fast-glob** and does
not claim its API or version identity. It replaces only the `fast-glob` dependency
edge of `@next/eslint-plugin-next@16.3.6`. Its only export is
`globSync(stringPattern, { onlyDirectories: true })`.

## Accepted contract

Literal directory paths and path components consisting entirely of one `*` are
supported, for example `.`, `packages/app`, `with space/web`, `@scope/app`, and
`packages/*/web`. Relative inputs retain relative results; absolute inputs return
absolute results. Missing paths and files produce no directory matches. Result
ordering and trailing separator spelling are not part of the contract.

Arrays, empty/non-string patterns, patterns longer than 4096 characters, control
characters, unknown or symbol options, and anything other than the exact own data
property `{ onlyDirectories: true }` throw `TypeError`. Globstar, braces, brackets,
extglobs, parentheses, `?`, negative patterns, and partial-component stars are
unsupported and throw rather than silently returning no matches. Examples include
`src/**`, `src/{**,lib}`, and `src/!(lib)/**`.

After the first complete `*` component, `.` and `..` components are also rejected:
`packages/*/./web` and `packages/*/../web` cannot be safely normalized without
changing which directories match. Leading `./` and `../`, and dot components in
fully literal paths, remain supported.

Native Windows backslashes are deliberately normalized to `/`. On POSIX,
backslashes (including glob escapes) are rejected. Next itself normalizes
backslashes before calling its dependency. Bounded raw checks reject
parser-sensitive syntax before the public `picomatch.scan` API is called. There
is no custom glob parser and no globstar suffix rewriting. `tinyglobby` receives
`expandDirectories: false`, `onlyDirectories: true`, and absolute mode for absolute
inputs.

The public `tinyglobby` filesystem hook classifies symlinks to directories as
directory Dirents, preserving both matched aliases and traversal through them.
It leaves file and broken links unchanged, tolerates only `ENOENT`, `ENOTDIR` and
`ELOOP` from link stat, and propagates other errors. There is no extra traversal
or realpath deduplication. Because fdir suppresses directory-read exceptions, each
call records an unexpected stat error and rethrows the original error after the
synchronous crawl; no error state is shared between calls. Finite-pattern tests cover nested aliases, self/parent
cycles, file links and broken links in a bounded child process.

## Consumer and maintenance boundary

Next 16.3.6's `dist/utils/get-root-dirs.js` uses only
`globSync(rootDir.replace(/\\/g, '/'), { onlyDirectories: true })`. Its default
root is `context.cwd` and does not call this adapter. Next flattens rootDir setting
arrays into individual string calls; the adapter itself does not accept arrays.
The repository's ESLint configuration is unchanged.

The committed golden fixture was captured from the actual locked/installed
fast-glob **3.3.1** before replacement, using a disposable tree. It records both
normalized lexical output paths and realpath identity sets for literals, spaces,
scoped names, relative/absolute paths, complete `*` segments, directory symlinks,
hidden directories, missing paths, and `.`. The reference implementation is not
installed or required by the regression tests. The tests also exercise the real
Next rule, the default bypass, rootDir arrays, React hooks, JSX accessibility,
TypeScript and Next lint rules, and bounded hostile-brace rejection in a child.

Upgrading Next requires rechecking the actual consumer source, supported call
shape, golden directory identities, real lint diagnostics, clean `npm ci`, peer
tree, and full/production audits. This adapter intentionally does not support the
full documented rootDir glob language. Expanding its syntax requires an explicit
review of the security boundary, not a fallback to another parser.

## Reproducible local package

The dependency is the committed `tools/vendor/jobtracker-next-root-glob-1.0.0.tgz`,
not a directory link. npm 10 resolves a scoped override's relative directory file
reference against the consumer package and creates a dangling link. A local
tarball retains this package's honest identity and works with the same scoped
`$@jobtracker/next-root-glob` override, ordinary `npm ci`, and a valid peer tree.
It has no lifecycle hooks and includes only `package.json`, `index.cjs`, and this
README.

For a future source release, bump the private package version and its tarball
filename/direct dependency spec together; do not reuse a committed artifact name
for different bytes. Build the archive before regenerating the lock with normal
npm tooling:

```sh
npm pack ./tools/next-root-glob --pack-destination ./tools/vendor --ignore-scripts --json
npm install --package-lock-only --ignore-scripts
npm ci
```

The initial migration of an existing npm 10 lock also requires refreshing stale
consumer metadata: remove only the lock package records for
`node_modules/@next/eslint-plugin-next`, `node_modules/@istanbuljs/load-nyc-config`,
and the latter's nested `node_modules` subtree, then regenerate with the command
above. An unchanged old consumer record otherwise resolves even the tarball
relative to the consumer and fails with `ENOENT`. Do not hand-author replacement
versions or integrity values. Verify the regenerated graph with normal `npm ci`
and `npm ls --all`; the migration retained all existing package versions except
the intentional tinyglobby `0.2.15` to `0.2.17` change.

Regression tests repack into a disposable directory and require byte parity with
the committed archive, inspect its exact file list, compare installed source
bytes, and resolve its identity relative to the actual Next consumer. This catches
source/archive/lock drift instead of trusting an audit-only result.

## NYC YAML compatibility

The separate scoped override for `@istanbuljs/load-nyc-config@1.1.0` uses
`js-yaml@4.3.2`. Tests call the real NYC loader for `.yml` and `.yaml`, extends,
arrays, booleans, paths and numeric thresholds. This is not universal YAML3
parity: unsafe `!!js/function` tags are intentionally rejected. YAML4 interprets
unquoted `012` as decimal 12, `0o12` as octal 10, and `1:20` as a string; YAML3
interpreted these as octal 10, a string, and sexagesimal 80 respectively. Quote
ambiguous values, and use ordinary decimal numbers for coverage thresholds.
