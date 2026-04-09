# JobTracker

A job application tracker that auto-extracts job details from URLs. Use the Chrome extension to capture job title, company, location, and description from LinkedIn, Indeed, Glassdoor, and any career page.

**Live app:** [easy-job-application-tracker.vercel.app](https://easy-job-application-tracker.vercel.app)

## Features

- **Chrome extension** -- save jobs directly from LinkedIn, Indeed, Glassdoor, and any career site
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

You should see "JobTracker" in your extensions list.

### 2. Save a Job

1. Go to any job posting on LinkedIn, Indeed, Glassdoor, or any career page
2. Click the JobTracker extension icon in Chrome
3. Review the extracted data (title, company, location)
4. Click **Save Application**
5. Click **Open** to view it in the app

### 3. Auto-Fill Application Forms (Optional)

The extension can fill your LinkedIn and GitHub URLs on job application forms automatically.

1. Open the app and go to **Settings**
2. Add your profile URLs under **Profile URLs**
3. Navigate to any job application form (Greenhouse, Lever, Workday, etc.)
4. Click the extension and press **Fill Profiles**

### 4. Configure AI Extraction (Optional)

AI extraction helps when job postings don't have standard meta tags. It's not required -- basic extraction works without it.

1. Go to **Settings** in the app
2. Select your LLM provider (OpenAI, Google Gemini, or Anthropic)
3. Enter your API key
4. Click **Save Settings**

## Run Locally (Optional)

If you prefer to self-host instead of using the live app:

### What You'll Need

- **Node.js** 18+ -- [nodejs.org](https://nodejs.org/)
- **PostgreSQL** database -- [Neon](https://neon.tech) (free) or any PostgreSQL provider

### Setup

```bash
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker
npm install
cp .env.example .env
```

Edit `.env` with your PostgreSQL connection string:

```
DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require"
ENCRYPTION_SECRET="any-random-string-at-least-32-characters-long"
```

Then:

```bash
npx prisma generate
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Update the extension's server URL in the popup to `http://localhost:3000`.

## Troubleshooting

**Extension says "Could not extract":**
- Try clicking **Re-extract** -- some pages load content dynamically
- The extension will automatically fall back to server-side extraction

**Extension can't connect to the app:**
- Check the server URL in the extension popup matches your app URL
- If self-hosting, make sure the app is running

**Pages keep refreshing (local only):**
- Stop the app, delete the `.next` folder, and restart:
  ```bash
  rm -rf .next
  npm run dev
  ```

## License

MIT
