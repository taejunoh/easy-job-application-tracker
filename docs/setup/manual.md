# Manual development setup

This guide is for contributors who want to run the Next.js development server directly on their computer instead of using the Docker-based [local setup in the README](../../README.md#run-it-locally). It assumes Git, Node.js `>=22.22.2 <23`, npm, and PostgreSQL are installed. For hosted production, use the separate [deployment overview](deployment.md); do not use these development instructions as a production deployment procedure.

## Install dependencies

From the repository root:

```bash
npm ci
```

Create `.env` from the example without overwriting an existing file:

```bash
node -e "const fs=require('node:fs');if(fs.existsSync('.env')){console.log('.env already exists; leaving it unchanged')}else{fs.copyFileSync('.env.example','.env',fs.constants.COPYFILE_EXCL)}"
```

Generate two separate secrets. Run this command twice and keep both outputs private:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## Configure PostgreSQL and the app

Create a new, empty database, for example:

```bash
createdb jobtracker
```

Edit `.env` with the database connection details and your two distinct generated secrets. For a local server on the default port, the relevant values look like:

```dotenv
DATABASE_URL="postgresql://<db-user>:<db-password>@127.0.0.1:5432/<db-name>"
ENCRYPTION_SECRET="<first-generated-secret>"
APP_ACCESS_TOKEN="<second-generated-secret>"
APP_BASE_URL="http://localhost:3000"
CORS_ALLOWED_ORIGINS="http://localhost:3000,chrome-extension://<extension-id>"
APPLICATION_IDENTITY_WRITES_ENABLED="0"
APPLICATION_WRITES_ENABLED="1"
```

Replace every placeholder. If you have not installed the extension yet, you can omit its origin from `CORS_ALLOWED_ORIGINS` until you do. Percent-encode reserved characters in database URL components (for example, `@` becomes `%40`). `APP_BASE_URL` must be an origin without a path, and CORS origins must be exact.

The access token is used only to sign in to the web app at `/connect`; never give it to the extension. The encryption secret protects provider API keys stored in settings. Do not reuse one value for both or commit `.env`.

For a new empty database, apply the checked-in migrations:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
```

Then start the development server:

```bash
npm run dev
```

Open the configured app origin and sign in at its `/connect` page with `APP_ACCESS_TOKEN`. The Dashboard's **Add application** card is open by default. URL extraction can use page metadata without an AI key; fetch or login restrictions may prevent reading a job page. Review and complete title, company, and job URL in the confirmation before saving. **Paste Text** requires both a description and job URL, and a saved provider API key.

`APPLICATION_IDENTITY_WRITES_ENABLED` is a maintenance gate; keep it at `0` for ordinary development. `APPLICATION_WRITES_ENABLED` controls normal application mutations and should be `1` for local development. These are server-only settings, not extension options.

Do not point these instructions at an existing database containing data unless you have reviewed the migration state and have a verified backup. For an existing or production database, follow the [production operations runbook](../operations/production-runbook.md); never use destructive reset or `db push` as a shortcut.

## Optional Chrome extension

Chrome 140 or newer is required. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the repository's `extension/` folder. Copy the extension ID shown on its details card, then add the exact origin `chrome-extension://<extension-id>` to `CORS_ALLOWED_ORIGINS` and restart `npm run dev` so the server reads the change.

To pair it, sign in to the web app and open **Settings → Chrome extension installations**. Select the exact extension origin and choose **Create pairing code**. In the extension popup, enter the exact server origin (for example, `http://localhost:3000`) and the short-lived one-time code. Choose **Connect** and approve Chrome's server-origin permission prompt if it appears. The pairing code is not the web access token or an AI provider key; it can be used only once and expires after ten minutes. Never put credentials in URLs, screenshots, chats, or commits.

## Optional settings

- **Resume:** Under Settings, upload a PDF or TXT resume and save settings. Resume matching needs a saved resume and job description; results are keyword comparisons, not a hiring prediction.
- **AI extraction:** Choose OpenAI, Google Gemini, or Anthropic under Settings and save that provider's API key. Basic URL metadata extraction does not need the key; AI requests may incur provider usage charges. Stored keys are encrypted with `ENCRYPTION_SECRET`.
- **Profile URLs:** LinkedIn and GitHub profile URLs can be saved in Settings and used by the extension on supported application forms.

The Manual tab is gated by `VALIDATION_MANUAL_ENTRY_ENABLED` and is intended only for validation. It is off by default; keep it off for normal use.

## Development checks

Run the repository checks before opening a pull request:

```bash
npm run check:audit
npm run check:extension
npm run test:ci
npm run lint
npm run typecheck
npm run build
npm run check:startup-env
```

Changes to backup or restore behavior also require the guarded PostgreSQL 17 Docker integration check:

```bash
npm run test:backup:docker
```

The guarded local Chrome extension E2E wrapper is:

```bash
npm run test:extension:e2e:local
```

It requires PostgreSQL 17 on `127.0.0.1:5432`, creates and removes the exact disposable database `jobtracker_extension_e2e_test`, and uses isolated Playwright Chromium profiles. It does not use the system Chrome profile. Do not run the lower-level `npm run test:extension:e2e` directly unless its destructive-test sentinels, disposable database, build, and browser prerequisites have been prepared; CI invokes that lower-level command in its guarded environment. For coverage, privacy rules, and production system-Chrome steps, see the [Chrome extension smoke runbook](../operations/chrome-extension-smoke.md).

## Screenshot maintenance

With the development server running, regenerate all documentation screenshots with `npm run screenshots`. To generate only the network-blocked synthetic extension setup images, use `npm run screenshots:setup`; this command does not require a running server. See the [screenshot guide](../screenshots/README.md) for the eight image descriptions and requirements.

## Documentation index

- [README](../../README.md) — Docker-first local setup and first application walkthrough.
- [Deployment overview](deployment.md) — hosted deployment boundary; the production runbook remains authoritative.
- [Production operations runbook](../operations/production-runbook.md) — deployment, migration, backup, recovery, and incident procedures.
- [Chrome extension smoke runbook](../operations/chrome-extension-smoke.md) — guarded E2E and production browser verification.
- [Quarantine operations runbook](../operations/quarantine-runbook.md) — repository data cleanup and recovery procedure.
- [Sanitized production cutover record](../operations/production-cutover-2026-07-14.md) — release evidence record.
- [Screenshot generation guide](../screenshots/README.md) — synthetic screenshot workflow.
- [Dependency audit report](../security/dependency-audit-2026-07-14.md) — recorded dependency review.
