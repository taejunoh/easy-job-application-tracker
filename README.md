# JobTracker

A local-first job application tracker that auto-extracts job details from URLs. Paste a job posting URL or use the Chrome extension to capture job title, company, location, and description automatically.

## Features

- **Auto-extract from URLs** -- paste any job posting URL and get title + company extracted via meta tags or AI
- **Chrome extension** -- extract job data directly from LinkedIn, Indeed, and Glassdoor while logged in
- **Auto-fill profiles** -- automatically fill LinkedIn and GitHub profile URLs on application forms (Greenhouse, Lever, Workday)
- **Text paste mode** -- copy/paste job description text for AI-powered extraction
- **Multi-LLM support** -- choose OpenAI, Google Gemini, or Anthropic Claude for AI extraction
- **Dashboard** -- stats, status breakdown chart, and recent applications
- **Full CRUD** -- search, filter, sort, edit, and delete applications
- **Local SQLite database** -- your data stays on your machine

## What You'll Need

Before starting, make sure you have these installed:

- **Node.js** (version 18 or newer) -- download from [nodejs.org](https://nodejs.org/). Pick the LTS version.
- **Git** -- download from [git-scm.com](https://git-scm.com/) (or use `brew install git` on Mac)
- **Google Chrome** -- for the browser extension

To check if you already have them, open Terminal (Mac) or Command Prompt (Windows) and run:

```bash
node -v    # should show v18 or higher
git -v     # should show a version number
```

## Quick Start

Open your terminal and run these commands one at a time:

```bash
# 1. Download the project
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker

# 2. Install dependencies (this may take a minute)
npm install

# 3. Set up the config file
cp .env.example .env
```

Now open the `.env` file in any text editor and replace the placeholder with a random string. You can use this one or make your own (any 32+ characters will work):

```
DATABASE_URL="file:./dev.db"
ENCRYPTION_SECRET="change-me-to-any-random-string-at-least-32-chars"
```

Then continue in the terminal:

```bash
# 4. Set up the database
npx prisma generate
npx prisma db push

# 5. Start the app
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. You should see the JobTracker dashboard.

## Configure AI Extraction (Optional)

AI extraction helps when job postings don't have standard meta tags. It's not required -- basic extraction works without it.

1. Go to **Settings** in the app
2. Select your LLM provider (OpenAI, Google Gemini, or Anthropic)
3. Enter your API key (you'll need an account with one of these providers)
4. Click **Save Settings**

## Chrome Extension

The extension lets you save jobs directly from LinkedIn, Indeed, and Glassdoor with one click.

### Install the Extension

1. Open Google Chrome
2. Type `chrome://extensions` in the address bar and press Enter
3. Turn on **Developer mode** using the toggle in the top-right corner
4. Click **Load unpacked**
5. Navigate to the `extension/` folder inside the project and select it

You should see "JobTracker" appear in your extensions list.

### Save a Job

1. Make sure the app is running (`npm run dev` in your terminal)
2. Go to any job posting on LinkedIn, Indeed, or Glassdoor
3. Click the JobTracker extension icon (puzzle piece icon in Chrome toolbar)
4. Review the extracted data (title, company, location)
5. Click **Save Application**

### Auto-Fill Application Forms

The extension can automatically fill your LinkedIn and GitHub profile URLs on job application forms (Greenhouse, Lever, Workday).

1. Go to **Settings** in the app and add your profile URLs under **Profile URLs**
2. Navigate to any job application form
3. Click the extension and press **Fill Profiles**

## Input Modes

The app has two input modes (toggle with tabs at the top):

- **URL** -- paste a job posting URL. Works best with company career pages and public job boards.
- **Paste Text** -- copy/paste job description text from any page, and the AI extracts the title and company.

## Troubleshooting

**The app won't start / shows an error:**
- Make sure you've completed all setup steps (especially `npx prisma generate` and `npx prisma db push`)
- Check that your `.env` file exists and has both `DATABASE_URL` and `ENCRYPTION_SECRET` set

**Port 3000 is already in use:**
- Start on a different port: `npm run dev -- -p 3001`
- Then update the server URL in the extension popup to match

**Extension says "Could not extract":**
- Make sure the app is running
- Try clicking **Re-extract** in the extension popup
- Some pages may need you to scroll down first so the job details load

**Pages keep refreshing:**
- Stop the app, delete the `.next` folder, and restart:
  ```bash
  rm -rf .next
  npm run dev
  ```

## License

MIT
