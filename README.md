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
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Update the extension's server URL to `http://localhost:3000`.

## Troubleshooting

**Extension says "Could not extract":** Try **Re-extract** -- some pages load content dynamically.

**Keyword analysis shows no results:** Upload your resume in Settings and click Save first.

**Extension can't connect:** Check the server URL in the extension popup matches your app URL.

## License

MIT
