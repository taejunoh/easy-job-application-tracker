# Easy Local Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new user run JobTracker locally with one setup command, understand authentication, save an application, and retain data after restarting.

**Architecture:** A dependency-free Node CLI manages an isolated, ignored local environment and explicitly scoped Docker Compose app/database project. Built Next runs in production with a strictly bounded, default-off loopback HTTP mode; existing hosted production behavior is preserved. README and screenshots describe the tested web-first workflow.

**Tech Stack:** Node 22, Docker Compose, PostgreSQL, Next 16, Prisma 7, Jest, Playwright.

---

Work only in `/Users/taejunoh/Developer/LFG/easy-job-application-tracker/.worktrees/easy-onboarding`, based on `5e5610944698e18230c8e67378dda35d8eb311f8` plus selected UI commits. The primary checkout is dirty and out of scope. No production mutation or unrelated rollout commits. Implement sequentially; spec review precedes quality review for each task. The approved design is `docs/superpowers/specs/2026-10-07-easy-onboarding-design.md`.

## File responsibilities

- `scripts/local-setup.mjs`: dependency-free entrypoint and supported command dispatch, actionable non-secret errors.
- `scripts/local-setup-core.mjs`: managed config, explicit Compose execution, validation, dependency/tool checks; injectable filesystem/process boundaries for tests where useful.
- `scripts/local-container-start.mjs`: validate compose-owned DB target, migrate successfully, then launch the existing production startup path; fail before web startup on migration error.
- `Dockerfile`, `.dockerignore`, `compose.yaml`: production build, scoped dummy build env, internal DB, health checks, migration ordering, durable volume, loopback web binding.
- `package.json`: `setup`, `local:start`, `local:stop`, `local:logs`, `local:token`, `local:extension` scripts.
- `.gitignore`: managed local state exclusion.
- `src/lib/server-env-core.js`, `__tests__/lib/server-env.test.ts`: strict default-off local HTTP policy.
- `__tests__/scripts/local-setup.test.ts`: meaningful CLI/config/security regression tests.
- `README.md`, `docs/setup/manual.md`, `docs/setup/deployment.md`: beginner entrypoint and separately linked advanced guidance.
- `scripts/screenshots.mjs`, `scripts/screenshot-fixtures.mjs`, screenshot workflow tests, `docs/screenshots/*`: current synthetic visuals and fail-closed interception.
- `scripts/verify-local-onboarding.mjs`: opt-in Docker smoke harness using a disposable owned configuration/project, real auth/CRUD, simulated extraction only if needed, restart persistence, owned-resource cleanup without touching user state.

### Task 1: Automatic isolated setup and Docker runtime

- [ ] Add failing server-env tests first. Exact local policy contract:

```ts
const origin = "http://127.0.0.1:3000";
const local = { ...productionSource, LOCAL_DOCKER_HTTP_ENABLED: "1",
  APP_BASE_URL: origin, CORS_ALLOWED_ORIGINS: origin };
expect(parseServerEnv(local, "production").appOrigin).toBe(origin);
expect(() => parseServerEnv({ ...local, LOCAL_DOCKER_HTTP_ENABLED: "0" }, "production")).toThrow("APP_BASE_URL");
expect(() => parseServerEnv({ ...local, CORS_ALLOWED_ORIGINS: `${origin},https://other.example` }, "production")).toThrow("CORS_ALLOWED_ORIGINS");
```

Also table-test literal localhost acceptance; remote HTTP/HTTPS app in local mode rejection; alternate loopback CORS rejection; credentials/path/query/hash/aliases/wildcards rejection; exact extension acceptance; invalid flag values rejection; unchanged default HTTPS production and development behavior. Run `npm test -- --runInBand __tests__/lib/server-env.test.ts`; new local-mode cases must fail before implementation.

- [ ] Implement local mode by threading a parsed binary flag through APP_BASE_URL/CORS parsing, keeping ordinary production logic unchanged. Do not set NODE_ENV=development or change cookie/session behavior. Add the managed flag only to Docker runtime env; do not enable it in `.env.example`.

- [ ] Add red tests for config lifecycle and CLI boundaries. Required assertions: two independently generated 64-hex application secrets and DB password; persisted `jobtracker-[a-f0-9]{12}` project ID; mode0600 on POSIX; existing config byte-identical after retry; root `.env` untouched; malformed/symlinked config rejected; only owned db URL migratable; secrets omitted from diagnostics; unsupported Node/Docker/Compose failure instructions; fixed `-f`, `--env-file`, `--project-name`; scrub inherited Compose/interpolation keys; preserve unrelated environment keys. Failed port binding/start must explain retry/port choice, not delete state. Run `npm test -- --runInBand __tests__/scripts/local-setup.test.ts` and confirm new tests fail.

- [ ] Implement the dependency-free CLI with these commands and semantics:

```text
npm run setup [-- --port 3000]  # check tools, create/reuse managed config, build, migrate, start healthy app
npm run local:start             # reuse config and durable data; start healthy app
npm run local:stop              # stop owned app/db, keep volume/config
npm run local:logs              # logs from explicitly scoped project
npm run local:token             # reveal only managed APP_ACCESS_TOKEN explicitly
npm run local:extension -- abcdefghijklmnopabcdefghijklmnop
                               # validate exact ID, append exact extension CORS once, recreate app
```

Use Node builtins `randomBytes`, exclusive `open`, chmod, `spawnSync`/spawn and strict parsing. Managed values are fixed allowlisted keys; reject unknown/missing/duplicate values, unsafe numeric port or conflicting persisted origin. Validate config before any Docker mutation. Emit URL and token-command instructions on success; do not print secrets or Docker `config` interpolation output. Never read root env files. Never run Docker down with `-v`.

- [ ] Add Docker runtime. Use Node22 Debian image and Postgres stable major, exact Compose service names `app`, `db` and a migration step (one-shot service or scoped `run --rm app ...`). Runtime app binds container0.0.0.0:3000; Compose host binds `127.0.0.1:${JOBTRACKER_PORT}:3000`. DB health check `pg_isready`; volume at version-appropriate data directory; app depends on healthy DB and successful migrations. Use full npm-ci dependencies initially to keep Prisma CLI available. Build command receives only dummy HTTPS env scoped to build; runtime env explicitly maps managed secrets and owned DATABASE_URL. Exclude `.env*` except `.env.example`, `.jobtracker`, node_modules, `.next`, Git/worktrees and artifacts from image context.

- [ ] Verify red→green tests, `npm run lint`, `npm run typecheck` and `docker compose ... config --quiet` with throwaway managed env without logging contents. Commit only named task files after reviewing diff. Report exact checks and remaining uncertainty. Spec review, then security/quality review; fix findings before Task2.

### Task 2: Beginner documentation and current synthetic screenshots

- [ ] Preserve old manual setup/deployment commands in `docs/setup/manual.md` and `docs/setup/deployment.md` as appropriate, linking existing authoritative production runbook. Rewrite README to lead with product screenshot, optional extension, prerequisites and:

```bash
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker
npm run setup
npm run local:token
```

Explain initial image download/build time, localhost URL, token privacy, first URL extraction→review→Save, AI-key-only Paste Text, where data lives, persistence, safe update/start/stop/log commands, port conflict, Docker daemon failure and invalid config recovery without losing secrets. Explicitly distinguish access token, short-lived pairing code and provider API key. Keep Manual off. Clarify single-user local/private self-hosted scope and production HTTPS needs.

- [ ] Add optional extension instructions: load unpacked `extension/`, copy extension ID, `npm run local:extension -- <id>`, create pairing code in Settings, configure server URL/pair extension. No access token in extension or screenshot. Link AI setup and supported provider behavior from actual UI, not invented capability.

- [ ] Add failing screenshot regression tests for current semantic settings locators, synthetic extension-installation API response and unknown API abort. Then replace stale `div.bg-gray-900` selectors with semantic section/heading/card locators. Allow explicit screenshot base URL/config suitable for isolated Docker without reading production env; no real settings/API reads. Existing authentication remains real local session; all screenshot data APIs synthetic. Run targeted screenshot tests and `npm run screenshots` against the owned local app. Inspect all8 PNGs visually and update screenshot README; no real tokens/data in pixels.

- [ ] Run docs-link/path checks and screenshot tests, inspect diff and generated PNGs, then commit named docs/script/test/image files. Spec review then quality review. No repeated broad regression for prose-only corrections.

### Task 3: Fresh installation and restart proof

- [ ] Add an opt-in smoke harness and npm command `test:onboarding:docker`. Use a temporary project/config directory owned by the harness, random free host port, fixed repo Compose path and independent project ID. Do not call the user's default `.jobtracker` or existing Docker projects. Fail unless managed DATABASE_URL is owned. Capture high-level step results, not credentials.

- [ ] Harness first invokes the same setup entrypoint (with internal injectable/config-directory seam, not arbitrary external DB override), waits healthy, authenticates at the real session endpoint and verifies unauthenticated write rejection. Use Playwright to save synthetic sample application through URL→confirmation→Save. Intercept only extraction as a clearly labeled deterministic fixture if external metadata is unreliable. Keep Application/auth APIs and PostgreSQL real. Verify saved ID via real read endpoint, update status and retain record for restart proof. Recreate app+db containers without volume deletion, reauthenticate with original token and verify the same record ID/data. Delete test record and remove only harness-owned containers/volume after proof; keep failure logs redacted.

- [ ] Run actual `npm run test:onboarding:docker`. Additionally run setup twice and assert persisted config/secrets unchanged, an unrelated root.env sentinel unchanged, and no-host-node_modules setup works (temporary clean exported source or dependency-free entrypoint proof). Test safe stop/start and optional extension command idempotence. Inspect container listening addresses; DB has no published port and web only127.0.0.1. Do not silently skip Docker failures.

- [ ] Run final `npm run lint`, `npm run typecheck`, `npm run check:extension`, `npm run check:startup-env`, full `npm run test:ci` once, image build and screenshot tests. Record actual counts and exit codes. Fix substantive failures with targeted red→green regression before rerunning affected checks.

- [ ] Final read-only whole-diff review, including default hosted-production behavior, secret handling, duplicate config/concurrent setup, migration guard, persistence and README accuracy. Record final verification in design docs and commit named files. Recheck live origin/main and branch divergence; never incorporate unrelated13rollout commits or dirty primary files.

### Task 4: Publish reviewed changes

- [ ] Fetch/recheck live main. If main moved, integrate it in this isolated branch and rerun affected checks; no force push. Push `codex/easy-onboarding`, create a focused PR and attach it to this chat. Check CI/build results and resolve actionable failures. Merge to main only with green relevant checks and final review; leave original dirty primary checkout untouched. Verify remote main contains the resulting commit.

- [ ] Final Korean handoff: setup command, optional token command, completed docs/Docker/screenshots, verification summary, PR/main link, and any specific unverified limitation. Do not say everything completed if a required check or publication remains blocked.
