# JobTracker

A job application tracker that auto-extracts job details from URLs. Use the Chrome extension to capture job title, company, location, and description from LinkedIn, Indeed, Glassdoor, Lever, and any career page.

**Live app:** [easy-job-application-tracker.vercel.app](https://easy-job-application-tracker.vercel.app)

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

### 3. Save and Analyze Jobs

1. Go to any job posting (LinkedIn, Indeed, Glassdoor, Lever, etc.)
2. Click the JobTracker extension icon
3. Click **Save Application** to track it
4. Click **Analyze Keywords** to see your resume match

### 4. Auto-Fill Application Forms (Optional)

1. Add your LinkedIn and GitHub URLs in **Settings > Profile URLs**
2. On any application form, click the extension and press **Fill Profiles**

### 5. Configure AI Extraction (Optional)

AI extraction helps when job postings don't have standard meta tags. Not required -- basic extraction works without it.

1. Go to **Settings**, select your LLM provider, enter your API key
2. Click **Save Settings**

## Run Locally

If you prefer to self-host instead of using the live app:

```bash
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker
npm install
cp .env.example .env
```

Edit `.env`:

```
DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require"
ENCRYPTION_SECRET="any-random-string-at-least-32-characters-long"
```

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
