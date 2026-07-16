# README User Guide Refresh — Design Spec

## Context

The current README accurately describes most JobTracker capabilities, but its
first-use path begins with the Chrome extension before explaining that the
extension needs a running JobTracker server, a PostgreSQL database, and an
application access token. Beginner instructions, production operations, CI
details, and destructive-test safeguards are also presented at nearly the same
level, which makes it difficult for a new user to identify the shortest safe
path to a working installation.

This change rewrites the README as an English, task-first guide. The primary
journey is local self-hosting followed by Chrome extension pairing and the first
saved job. Hosted deployment, operations, and contributor verification remain
available later as clearly separated advanced material.

## Audience

The primary reader is a first-time user who can copy terminal commands but may
not yet understand the relationship between the web app, PostgreSQL, the access
token, Chrome host permissions, and the extension. A secondary reader is a
self-hosting operator or contributor who needs exact environment, migration,
test, and runbook references.

The README stays entirely in English. It does not split instructions by macOS,
Windows, or Linux because the extension workflow is the same on desktop Chrome
and the server prerequisites can be described with platform-neutral commands.

## Goals

1. Let a new user understand the three required pieces in under a minute:
   PostgreSQL, the JobTracker web app, and the unpacked Chrome extension.
2. Provide a copyable local setup path with no invalid placeholder left
   unexplained.
3. Explain where `APP_ACCESS_TOKEN` comes from and how the same token is used by
   the web `/connect` page and the extension popup.
4. Explain how to find the unpacked extension ID and add its exact origin to
   `CORS_ALLOWED_ORIGINS` before connecting.
5. Walk through the first useful outcome: save a job, upload a resume, analyze
   keywords, and optionally fill profile URLs.
6. Make common Chrome permission and connection failures diagnosable without
   requiring the operations runbook.
7. Preserve authoritative production, migration, CI, security, and E2E details
   while moving them out of the beginner path.
8. Add visual guidance for the three setup states that are currently text-only:
   loading the unpacked extension, entering connection details, and confirming
   a successful connection.

## Non-Goals

- Publishing the extension to the Chrome Web Store
- Providing a shared public access token for the existing production instance
- Adding an automated installer or changing application behavior
- Capturing the owner's real Chrome profile, open tabs, production token, or
  other personal browser state
- Replacing the production or Chrome smoke runbooks
- Adding operating-system-specific PostgreSQL installation tutorials
- Documenting unfinished Slice 3 quarantine recovery work as a user feature

## Chosen Approach

Use a layered, task-first README.

The opening sections optimize for successful first use. Detailed deployment,
database, testing, and operational contracts come afterward and link to the
existing runbooks. This preserves the repository's security constraints without
forcing a new user to read CI guard internals before loading the extension.

Two alternatives were rejected:

- **Deployment-first:** technically rigorous, but delays the first visible
  result and obscures the extension journey.
- **Reference-first:** easy to search after setup, but difficult to follow as a
  first-run tutorial.

## README Information Architecture

### 1. Product overview

- One-sentence description
- Dashboard screenshot
- Short list of the most important capabilities
- A plain-language architecture note:
  `Chrome extension → JobTracker server → PostgreSQL`
- Explicit statement that the extension is not standalone

### 2. Five-minute orientation

Explain what the user will do and what they need:

- Desktop Google Chrome meeting the manifest's minimum version
- Node.js `22.22.2` or a compatible Node 22 release allowed by `package.json`
- A reachable PostgreSQL database
- Git and npm

The section must distinguish required items from optional LLM credentials.

### 3. Local Quick Start

Present one numbered journey:

1. Clone the repository and install locked dependencies with `npm ci`.
2. Copy `.env.example` to `.env`.
3. Generate two independent secrets with a cross-platform Node.js command,
   avoiding an OpenSSL-only prerequisite.
4. Fill every environment variable and explain each value in a compact table.
5. Apply Prisma migrations.
6. Start the supported development command, `npm run dev`.
7. Open `/connect`, enter `APP_ACCESS_TOKEN`, and confirm the dashboard loads.

The example local origin is `http://localhost:3000`. The guide must state that
placeholder values in `.env.example` are intentionally rejected.

### 4. Install and connect the Chrome extension

Use the actual Chrome flow:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the repository's `extension/` directory.
4. Copy the extension ID shown on its card.
5. Add `chrome-extension://<extension-id>` to
   `CORS_ALLOWED_ORIGINS`, retaining the app origin.
6. Restart the development server after changing `.env`.
7. Pin JobTracker to the toolbar.
8. Open the popup, enter the JobTracker URL and `APP_ACCESS_TOKEN`, select
   **Connect**, and approve the server-site permission prompt.
9. Explain the expected connected status and that the token input is cleared
   after successful connection.

The guide must clarify that Chrome's extension details page can continue to
show the granted server origin until **Disconnect** completes permission
cleanup. It must not tell users to enable broad access to every site. Job-board
access is requested or used only where required by the manifest and current
workflow.

Place three new sanitized images beside this journey:

1. `06-chrome-load-unpacked.png` — an instructional Chrome Extensions view
   highlighting **Developer mode**, **Load unpacked**, the JobTracker card, and
   the extension ID location.
2. `07-extension-connect.png` — the real extension popup layout in its
   disconnected state, using `http://localhost:3000` and a masked example token.
3. `08-extension-connected.png` — the popup after successful pairing, showing
   the connected status and an empty token field.

These are deterministic documentation visuals, not captures of a real user
profile. The Chrome Extensions image is rendered from a purpose-built static
HTML fixture because Playwright cannot automate privileged `chrome://` pages.
The two popup images reuse `extension/popup.html` styles and synthetic state,
following the existing screenshot pipeline. No real extension ID, access token,
browser avatar, history, bookmarks, or open tabs may appear.

### 5. First-use walkthrough

Guide the user through a concrete outcome:

1. Open a supported job page.
2. Open JobTracker and confirm or edit extracted title, company, and location.
3. Select **Save Application**.
4. Open the tracker and confirm the application appears.
5. Upload a PDF or text resume in Settings and select **Save Settings**.
6. Reopen a job and select **Analyze Keywords**.
7. Optionally configure LinkedIn and GitHub profile URLs and use
   **Fill Profiles** on supported forms.
8. Optionally configure OpenAI, Gemini, or Anthropic for fallback extraction.

Existing screenshots remain positioned next to the step they explain.

### 5a. Documentation image production

Extend the existing screenshot tooling with documentation-only fixtures rather
than manual screenshots. The generated assets live under `docs/screenshots/`
and use a consistent desktop-Chrome/popup visual language. Exact button labels,
field labels, and statuses must be sourced from the current extension UI where
possible.

The generated Chrome setup image must be clearly presented as an instructional
view, not claimed to be a pixel-perfect capture of a particular Chrome release.
The popup images must remain faithful to the checked-in popup HTML and CSS.
Regeneration instructions and the expanded image list are added to
`docs/screenshots/README.md`.

### 6. Troubleshooting

Use symptom → cause → action entries for at least:

- No Chrome permission prompt
- `Disconnected` after entering a token
- `401`, expired connection, or rejected token
- Server origin still visible after disconnect or reload
- Cannot extract a posting
- Save button fails
- Keyword analysis unavailable
- Resume upload fails
- PostgreSQL or Prisma migration failure
- Environment placeholder or origin validation failure

Troubleshooting must prefer safe, reversible actions. It must not recommend
deleting Chrome profiles, databases, or user records.

### 7. Advanced operation and development

Retain, simplify, and link the existing authoritative material:

- Vercel + managed PostgreSQL deployment
- Production environment rules
- Existing-database migration baseline procedure
- Supported `npm start` contract
- Backup, restore, cutover, and incident runbook links
- Extension E2E commands and destructive database guards
- CI summary
- Common contributor commands (`lint`, `typecheck`, `build`, tests)

Long guard explanations should be summarized in the README and delegated to the
existing operations documents where possible.

## Security and Accuracy Rules

- Never include a real access token, database credential, API key, extension
  token, or production secret.
- Never imply that the public Vercel URL is usable without the instance owner's
  access token.
- Use only commands present in `package.json` or verified platform tools.
- Preserve the exact five required server variables.
- State that LLM API keys are optional and stored encrypted by the app.
- Preserve the warning that Preview must not receive Production database
  credentials.
- Preserve the prohibition on destructive reset or `prisma db push` for data
  that must be retained.
- Keep extension permission descriptions aligned with `manifest.json` and the
  current Connect/Disconnect implementation.

## Validation

The README update is complete only when:

1. Every referenced file and screenshot exists.
2. Every npm command exists in `package.json`.
3. Environment variable names match `.env.example` and server validation code.
4. Extension labels and permission claims match `popup.html`, `popup.js`, and
   `manifest.json`.
5. All eight referenced screenshots exist, contain only synthetic data, and
   render legibly at the width used by GitHub's README viewer.
6. Relative Markdown links resolve from `README.md`.
7. Code fences are syntactically complete and commands contain no real secret.
8. Existing documentation contract tests pass.
9. Screenshot generation completes without accessing the configured database.
10. `npm run lint`, `npm run typecheck`, and relevant README/docs tests pass.
11. The original dirty `main` checkout and its 65 untracked files remain
   untouched.

## Deliverables

- Rewritten root `README.md`
- Three new sanitized setup images under `docs/screenshots/`
- Updated screenshot generator, synthetic fixtures, and screenshot regeneration
  notes
- This design spec
- An implementation plan under `docs/superpowers/plans/`
- No application, extension, database schema, or dependency changes
