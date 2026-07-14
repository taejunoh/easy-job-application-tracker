# JobTracker

A job application tracker that auto-extracts job details from URLs. Use the Chrome extension to capture job title, company, location, and description from LinkedIn, Indeed, Glassdoor, Lever, and any career page.

![Dashboard](docs/screenshots/01-dashboard.png)

## Features

- **Chrome extension** -- save jobs directly from LinkedIn, Indeed, Glassdoor, Lever, and any career site
- **Keyword match analysis** -- compare job descriptions against your resume to see matched and missing keywords
- **Resume upload** -- upload PDF or text resume in Settings for keyword matching
- **Auto-extract from URLs** -- paste any job posting URL and get title + company extracted automatically
- **Auto-fill profiles** -- fill LinkedIn and GitHub profile URLs on application forms (Greenhouse, Lever, Workday)
- **Text paste mode** -- copy/paste job description text for AI-powered extraction
- **Multi-LLM support** -- choose OpenAI, Google Gemini, or Anthropic Claude for AI extraction
- **Dashboard** -- stats, status breakdown chart, and recent applications
- **Full CRUD** -- search, filter, sort, edit, and delete applications

## Quick Start

### 1. Install the Chrome Extension

1. Download or clone this project:
   ```bash
   git clone https://github.com/taejunoh/easy-job-application-tracker.git
   ```
2. Open Google Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder inside the project

### 2. Set Up Your Resume

1. Open the app and go to **Settings**
2. Upload your resume (PDF or text) under **Resume**
3. Click **Save Settings**

Now keyword analysis works automatically in both the extension and the app.

![Settings — Resume upload](docs/screenshots/02-settings-resume.png)

### 3. Save and Analyze Jobs

1. Go to any job posting (LinkedIn, Indeed, Glassdoor, Lever, etc.)
2. Click the JobTracker extension icon
3. Click **Save Application** to track it
4. Click **Analyze Keywords** to see your resume match

![Extension popup on a job posting](docs/screenshots/03-extension-popup.png)

![Keyword match analysis](docs/screenshots/04-keyword-analysis.png)

### 4. Auto-Fill Application Forms (Optional)

1. Add your LinkedIn and GitHub URLs in **Settings > Profile URLs**
2. On any application form, click the extension and press **Fill Profiles**

### 5. Configure AI Extraction (Optional)

AI extraction helps when job postings don't have standard meta tags. Not required -- basic extraction works without it.

1. Go to **Settings**, select your LLM provider, enter your API key
2. Click **Save Settings**

![Settings — LLM provider](docs/screenshots/05-settings-llm.png)

## Run Locally

JobTracker supports both local self-hosting and hosted production operation. A
local instance stores data in the PostgreSQL database you configure. A hosted
Vercel instance stores application data in its configured PostgreSQL service,
such as Neon; provider credentials are encrypted before they are persisted.

```bash
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker
npm ci
cp .env.example .env
```

`npm ci` installs the exact dependency versions in `package-lock.json` and is
recommended for fresh checkouts and deployments.

Generate separate secrets for encryption and application access. Run this
command twice and keep each output private:

```bash
openssl rand -base64 32
```

Edit `.env` and replace every placeholder. The values in `.env.example` are
intentionally rejected if copied unchanged:

```
DATABASE_URL="postgresql://<db-user>:<db-password>@<db-host>:5432/<db-name>?sslmode=require"
ENCRYPTION_SECRET="<first-openssl-output>"
APP_ACCESS_TOKEN="<second-openssl-output>"
APP_BASE_URL="http://localhost:3000"
CORS_ALLOWED_ORIGINS="http://localhost:3000,chrome-extension://<extension-id>"
```

For a hosted production deployment, `APP_BASE_URL` must be the root HTTPS
origin (for example, `https://jobs.example.com`) and that exact origin must
also appear in `CORS_ALLOWED_ORIGINS`. Add only the Chrome extension origins
that should be allowed to connect. Production rejects plain HTTP, wildcard
origins, URL paths, and copied placeholder values.

```bash
npx prisma generate
npx prisma migrate deploy
npm run dev
```

Use `npm run dev` for local development. Its startup preloader loads Next.js
dotenv files and validates the complete server environment before Next.js opens
a listener.

Open [http://localhost:3000](http://localhost:3000). Update the extension's server URL to `http://localhost:3000`.

### Database Deployment

For a new hosted instance, create an empty PostgreSQL database, set
`DATABASE_URL` to that database, and apply the checked-in migration history:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status
```

Confirm that the `Application`, `Settings`, and `_prisma_migrations` tables are
present before starting the application. The Settings row is created lazily on
the first authenticated Settings request, so no database seed is required.

Start a self-hosted Node production deployment with:

```bash
npm start
```

For self-hosted Node, `npm start` and `npm run dev` are the only supported
application launch contracts. Direct `next start` and `npx next` invocations
are unsupported because they bypass the pre-listen environment preloaders.
Those contracts use `scripts/validate-startup-env-production.mjs` and
`scripts/validate-startup-env-development.mjs`, respectively.
`src/instrumentation.ts` remains request-blocking defense in depth across
supported deployments. Hosted platforms use their own lifecycle hooks; the
Vercel contract is documented below.

If an existing PostgreSQL database was previously created with
`prisma db push`, do not apply the initial migration directly. Back up the
database and verify that its Prisma-managed schema exactly matches the current
schema first:

```bash
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code
```

An empty diff exits with status `0`. Stop and resolve every reported difference
before continuing. Once the backup is complete and the diff is empty, record
the initial migration as already applied, then verify migration state again:

```bash
npx prisma migrate resolve --applied 20260713000000_init
npx prisma migrate deploy
npx prisma migrate status
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code
```

These migration commands operate only on PostgreSQL and do not import another
database automatically. Any legacy data import requires a separate, reviewed
export/import process.

Use `prisma db push` only for disposable development databases. Never run a
destructive reset or accept data loss on a database containing records you need
to keep. Rollback for the initial baseline is a tested database restore, not a
destructive down migration.

### Hosted Production

The supported hosted topology is Vercel for the application and Neon (or
another managed PostgreSQL provider) for the database. Production requires all
five server variables shown above, and Vercel Production must use Node 22. The
Vercel Next.js preset runs `npm run build`; Vercel does not run `npm start`.
When the build loads `next.config.ts`, the complete server environment is
validated at build time. At request-serving runtime, `src/instrumentation.ts`
validates it again before a new Node.js server instance handles requests.
`npm start` pre-listen validation applies to self-hosted Node only. Preview must
never receive Production database credentials.

Open `/connect` on the canonical HTTPS origin and enter the application access
credential to create a secure browser session. For Chrome extension pairing,
enter the same canonical server origin and access credential in the extension
popup, then select **Connect**. The extension origin must appear exactly in
`CORS_ALLOWED_ORIGINS`; wildcard origins are rejected.

Deployment, verification, backup, restore, incident response, and rollback
procedures are maintained in the
[production operations runbook](docs/operations/production-runbook.md). The
[2026-07-14 cutover record](docs/operations/production-cutover-2026-07-14.md)
contains sanitized release evidence.

### Chrome Extension E2E

Run the isolated extension journey locally with:

```bash
npm run test:extension:e2e:local
```

The wrapper requires a local PostgreSQL 17 server listening on the explicit
loopback address `127.0.0.1:5432`. It connects to the `postgres` maintenance
database as the `postgres` role by default; set
`EXTENSION_E2E_POSTGRES_ADMIN_URL` only when credentials or the explicit port
must differ. The hostname must remain canonical `127.0.0.1`, and the wrapper
requires PostgreSQL to report that exact server address before it creates the
database. The wrapper refuses to proceed if the exact disposable database
`jobtracker_extension_e2e_test` already exists. Otherwise, it creates that
database, builds the app with fixed non-production values, runs the E2E suite,
and force-drops the disposable database in its cleanup path. `SIGINT` and
`SIGTERM` stop the complete child process group before database cleanup.

The suite uses Playwright's bundled Chromium and a temporary browser profile;
it never launches or modifies system Chrome. It drives the actual extension
action popup through invalid and valid pairing, extraction, save, database
verification, popup reopen, disconnect, and server-`401` cleanup journeys.
The lower-level CI command is `npm run test:extension:e2e`; do not run it
directly unless its destructive-test sentinels, exact disposable database,
server identity, migration, build, and browser prerequisites are already in
place.

The automated scope and the required manual production verification are
documented in the
[Chrome extension smoke runbook](docs/operations/chrome-extension-smoke.md).

### Continuous Integration

The primary GitHub Actions verification job runs on Node.js 22.22.2 with a
disposable PostgreSQL 16 service. It installs the checked-in dependency graph,
validates and applies the Prisma migration history, verifies schema parity,
checks the extension's static assets, runs the full unit and database
integration suite, lints, typechecks with `next typegen`, and creates a
production build. A separate extension E2E job uses a digest-pinned PostgreSQL
17 service, installs Playwright's bundled Chromium, builds the app, and runs
`npm run test:extension:e2e`. All credentials in both jobs are fixed test-only
values; neither job requires repository secrets or contacts external
application services.

The database integration suite runs only when every destructive-test guard is
satisfied: `RUN_DATABASE_INTEGRATION=1`,
`ALLOW_DESTRUCTIVE_DATABASE_TESTS=jobtracker-ci-delete-all`, an explicit numeric
port on `localhost`, `127.0.0.1`, or `[::1]`, and exactly one decoded database
path segment matching `[A-Za-z0-9_]+_(ci|test)`. Query parameters, fragments,
connection-service options, socket targets, ambiguous user information, and
additional path segments are rejected. The suite also queries the connected
PostgreSQL server for its database, address, port, and current schema before
every bulk cleanup. The address must exactly match
`EXPECTED_DATABASE_SERVER_ADDRESS` (the inspected service-container bridge
address in CI), and the other identity fields plus the `public` schema must
match before any row is deleted. An integration run fails before
Prisma is imported if the URL guard is missing, and before mutation if the live
identity differs. Never point the suite at a development, staging, or
production database because it deletes every application and settings row
before and after the run.

The following reproduces the CI database gate with a uniquely named temporary
local database. It does not read or modify the database configured in `.env`:

```bash
DB="jobtracker_$(date +%s)_ci"
createdb -h 127.0.0.1 -U postgres "$DB"
trap 'dropdb -h 127.0.0.1 -U postgres --if-exists "$DB"' EXIT

export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/$DB"
export ENCRYPTION_SECRET="ci-encryption-secret-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
export APP_ACCESS_TOKEN="ci-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
export APP_BASE_URL="https://jobtracker.test"
export CORS_ALLOWED_ORIGINS="https://jobtracker.test,chrome-extension://abcdefghijklmnopabcdefghijklmnop"
export RUN_DATABASE_INTEGRATION=1
export ALLOW_DESTRUCTIVE_DATABASE_TESTS=jobtracker-ci-delete-all
export EXPECTED_DATABASE_SERVER_ADDRESS="127.0.0.1"

npx prisma migrate deploy
npm run test:ci
```

`EXPECTED_DATABASE_SERVER_ADDRESS` must equal the address reported by
PostgreSQL for the connection. It is `127.0.0.1` for the local reproduction
above. CI derives the exact PostgreSQL service-container address with
`docker inspect`; the integration guard does not accept an arbitrary private
network range.

The fixed credentials above are disposable test values. The application origin
must remain `https://jobtracker.test` and appear exactly in the CORS list when
reproducing the integration contract.

## Troubleshooting

**Extension says "Could not extract":** Try **Re-extract** -- some pages load content dynamically.

**Keyword analysis shows no results:** Upload your resume in Settings and click Save first.

**Extension can't connect:** Check the server URL in the extension popup matches your app URL.

## License

MIT
