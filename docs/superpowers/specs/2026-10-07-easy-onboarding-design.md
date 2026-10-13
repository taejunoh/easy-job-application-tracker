# Easy local onboarding — approved design

The user approved all proposed newcomer improvements on 2026-10-07: a web-first README, automated setup, Docker/PostgreSQL, current synthetic screenshots, and a fresh-install verification through first save and restart. Publish the verified work to main without including unrelated operations commits or modifying production data.

## User experience

After installing Git, Node 22.22.2–22.x and Docker with Compose, a new user clones the repository and runs `npm run setup`. Host dependency installation, manual PostgreSQL creation, secret generation, and migrations are not prerequisites. Setup builds a production-mode Next image and starts an isolated local PostgreSQL database. It prints the local URL and the command to reveal the access token; credentials are never printed by setup or passed in a URL.

`npm run local:token` reveals only the local access token on explicit request. The user pastes it at `/connect`, then saves a first application using URL extraction and confirmation. AI keys and Chrome are optional; Paste Text needs an AI provider. The validation-only Manual tab stays disabled.

Provide repeatable start, stop, logs and extension-allowlist commands. Stopping/recreating containers preserves the database and secrets. Setup is safe to retry. Never remove a volume as part of setup or normal stop.

## Isolation and security

Use ignored `.jobtracker/local.env`, created exclusively with restrictive permissions, instead of reading or writing root `.env*`. Persist a random Compose project name, independent 32-byte encryption/access secrets, and an independent PostgreSQL password. Existing valid managed configuration is reused; malformed or symlinked configuration fails closed with repair instructions. Do not silently regenerate credentials for an existing database.

Every Docker invocation specifies the repository Compose file, the managed environment file and persisted project name. Remove ambient Compose variables and all interpolation variables before spawning Docker, because shell values override `--env-file`. Reject remote Docker endpoints/contexts rather than pretending a remote daemon provides a local installation. The only database URL permitted for automatic migration is the compose-owned `db:5432/jobtracker`; verify this inside the app container before running migrations, and never migrate an arbitrary URL. Do not publish the DB port. Publish the web port only on 127.0.0.1. The app container runs non-root.

Next remains `NODE_ENV=production`. Add default-off `LOCAL_DOCKER_HTTP_ENABLED`, accepting only exact binary values. When enabled, APP_BASE_URL must be literal HTTP localhost or 127.0.0.1; CORS may contain that same web origin and exact Chrome extension origins only. Existing default production HTTPS rules and development behavior remain unchanged. Reject aliases, remote HTTP, alternate web origins, URL credentials, paths, wildcards and malformed extension IDs. Docker build uses scoped dummy HTTPS configuration and no real secrets; `.dockerignore` excludes all local credentials, generated output, Git and worktrees.

## Documentation and screenshots

README begins with a concise product description, screenshot and Docker quick start. Explain login token versus one-time extension pairing code versus optional AI provider key. Put manual developer setup and deployment/operator detail in separate linked guides, preserving authoritative production runbook ownership. Explain prerequisites, first save, stop/restart, updates, data location/backup warning, troubleshooting, optional Chrome extension and AI setup. Avoid implying a public multi-user service or a native app.

Refresh screenshots using synthetic data only. Match current semantic UI, mock extension-installation/settings/stats API data and fail closed on unknown API requests. Setup screenshots remain network-blocked. Do not expose real keys, private resumes or browser profiles.

## Acceptance evidence

Unit tests prove managed-config creation/reuse/failure, ambient env isolation, migration target guard, command failure diagnostics, strict local HTTP policy and default production behavior. A fresh Docker project proves image build, healthy DB, migrations, authenticated web access and real Application create/read/update/delete. Extraction may be explicitly simulated for deterministic browser save; authentication, persistence and CRUD must be real. Recreate app and DB containers without deleting volumes and verify the same saved record ID and credentials survive. Verify no-host-npm-ci startup from the setup entrypoint and preserve unrelated root env files.

Run targeted tests during implementation; final lint, typecheck, broad regression and screenshot checks before publishing. Report limitations rather than claiming unrun checks. Recheck live main, use a reviewable branch/PR and no force push. Leave dirty primary checkout untouched.
