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

JobTracker is designed to be self-hosted so your job data and API keys stay on your machine.

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

Start a production deployment with:

```bash
npm start
```

`npm start` and `npm run dev` are the only supported application launch
contracts. Direct `next start` and `npx next` invocations are unsupported, as
are standalone output and hosting platforms that replace the package scripts,
unless they execute `scripts/validate-startup-env-development.mjs` or
`scripts/validate-startup-env-production.mjs`, as appropriate, before opening
a listener. The instrumentation hook remains a request-blocking defense in depth;
Next.js 16 can print `Ready` before that hook finishes, so instrumentation alone
does not provide startup fail-fast behavior.

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

These migration commands operate only on PostgreSQL. They do not import or
convert an older `prisma/dev.db` SQLite file. Preserve that file and perform a
separate, reviewed data export/import if its records are still needed.

Use `prisma db push` only for disposable development databases. Never use
`prisma migrate reset`, `db push --force-reset`, or `--accept-data-loss` on a
database containing records you need to keep. Rollback for the initial
baseline is a tested database restore, not a destructive down migration.

### Continuous Integration

The GitHub Actions workflow runs on Node.js 22.22.2 with a disposable PostgreSQL
16 service. It installs the checked-in dependency graph, validates and applies
the Prisma migration history, verifies schema parity, checks the extension's
static assets, runs the full unit and database integration suite, lints,
typechecks with `next typegen`, and creates a production build. All credentials
in the workflow are fixed test-only values; the workflow does not require
repository secrets or contact external application services.

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
