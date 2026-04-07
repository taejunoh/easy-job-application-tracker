# JobTracker

A local-first job application tracker that auto-extracts job details from URLs. Paste a job posting URL or use the Chrome extension to capture job title, company, location, and description automatically.

## Features

- **Auto-extract from URLs** -- paste any job posting URL and get title + company extracted via meta tags or AI
- **Chrome extension** -- extract job data directly from LinkedIn, Indeed, and Glassdoor while logged in
- **Text paste mode** -- copy/paste job description text for AI-powered extraction
- **Multi-LLM support** -- choose OpenAI, Google Gemini, or Anthropic Claude for AI extraction
- **Dashboard** -- stats, status breakdown chart, and recent applications
- **Full CRUD** -- search, filter, sort, edit, and delete applications
- **Local SQLite database** -- your data stays on your machine

## Tech Stack

- Next.js 16 (App Router)
- Tailwind CSS
- Prisma + SQLite
- Cheerio (HTML parsing)
- OpenAI / Google Gemini / Anthropic SDKs

## Quick Start

```bash
# Clone the repo
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env and set a random ENCRYPTION_SECRET (any 32+ character string)

# Set up the database
npx prisma generate
npx prisma db push

# Start the app
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Configure AI Extraction

1. Go to **Settings** in the app
2. Select your LLM provider (OpenAI, Google Gemini, or Anthropic)
3. Enter your API key
4. Click **Save Settings**

AI extraction is optional -- meta tag parsing works without it. AI is only used as a fallback when meta tags don't provide enough info.

## Chrome Extension

The extension lets you extract job data directly from pages that require login (LinkedIn, Indeed, Glassdoor).

### Install

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project

### Usage

1. Make sure the app is running (`npm run dev`)
2. Navigate to a job posting on LinkedIn, Indeed, or Glassdoor
3. Click the JobTracker extension icon
4. Review the extracted data (title, company, location, description)
5. Click **Save Application**

## Input Modes

The app has two input modes (toggle with tabs at the top):

- **URL** -- paste a job posting URL. Works best with company career pages and public job boards. Auth-walled sites (LinkedIn) will prompt you to use other methods.
- **Paste Text** -- copy the job description text from any page, paste it, and the AI extracts the title and company.

## Upgrading to PostgreSQL

The app uses SQLite by default. To switch to PostgreSQL:

1. Update `prisma/schema.prisma` -- change `provider = "sqlite"` to `provider = "postgresql"`
2. Update `.env` -- set `DATABASE_URL` to your PostgreSQL connection string
3. Update `src/lib/prisma.ts` -- swap the adapter from `PrismaBetterSqlite3` to a PostgreSQL adapter
4. Run `npx prisma db push`

## License

MIT
