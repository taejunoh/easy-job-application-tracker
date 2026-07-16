# README User Guide Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the root README with an English, task-first self-hosting and Chrome extension guide, supported by three sanitized setup images that can be regenerated without a real database or Chrome profile.

**Architecture:** Keep the existing five product screenshots and add a setup-only mode to the current Playwright screenshot script. That mode renders one static instructional Chrome Extensions fixture and two synthetic states of the real popup HTML, so it never starts the app or reads PostgreSQL. A dedicated documentation contract test keeps the README headings, environment variables, image references, commands, and secret-safety rules aligned with the repository.

**Tech Stack:** Markdown, Node.js 22 ESM, Playwright Chromium, Jest 30, existing Chrome extension HTML/CSS

---

## File Map

- Create `scripts/chrome-extensions-setup.html` — synthetic, privacy-safe instructional Chrome Extensions view.
- Modify `scripts/screenshots.mjs` — add `--setup-only` routing and capture functions for images 06–08.
- Modify `scripts/screenshot-fixtures.mjs` — add only synthetic connection values used by the popup captures.
- Modify `package.json` — add the `screenshots:setup` command without changing dependencies.
- Create `docs/screenshots/06-chrome-load-unpacked.png` — generated instructional setup image.
- Create `docs/screenshots/07-extension-connect.png` — generated disconnected popup image.
- Create `docs/screenshots/08-extension-connected.png` — generated connected popup image.
- Modify `docs/screenshots/README.md` — document all eight images and both regeneration modes.
- Create `__tests__/docs/readme-user-guide.test.ts` — contract for setup visuals and the task-first README.
- Modify `README.md` — full English task-first user and operator guide.

### Task 1: Add the setup-visual documentation contract

**Files:**
- Create: `__tests__/docs/readme-user-guide.test.ts`
- Test: `__tests__/docs/readme-user-guide.test.ts`

- [ ] **Step 1: Write the failing setup-visual contract**

Create a Jest test that reads files from the repository root and asserts the new script, assets, and synthetic-only values:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const setupImages = [
  "06-chrome-load-unpacked.png",
  "07-extension-connect.png",
  "08-extension-connected.png",
] as const;

describe("task-first README user guide", () => {
  it("provides reproducible privacy-safe setup visuals", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const generator = readFileSync(join(root, "scripts/screenshots.mjs"), "utf8");
    const screenshotDocs = readFileSync(
      join(root, "docs/screenshots/README.md"),
      "utf8",
    );

    expect(packageJson.scripts["screenshots:setup"]).toBe(
      "node scripts/screenshots.mjs --setup-only",
    );
    expect(generator).toContain('process.argv.includes("--setup-only")');

    for (const image of setupImages) {
      expect(existsSync(join(root, "docs/screenshots", image))).toBe(true);
      expect(generator).toContain(image);
      expect(screenshotDocs).toContain(image);
    }

    expect(screenshotDocs).toContain("npm run screenshots:setup");
    expect(screenshotDocs).toContain("synthetic");
    expect(generator).not.toContain("easy-job-application-tracker.vercel.app");
  });
});
```

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
npx jest __tests__/docs/readme-user-guide.test.ts --runInBand
```

Expected: FAIL because `screenshots:setup`, the three PNGs, and the new generator branches do not exist.

### Task 2: Implement and generate the sanitized setup visuals

**Files:**
- Create: `scripts/chrome-extensions-setup.html`
- Modify: `scripts/screenshots.mjs`
- Modify: `scripts/screenshot-fixtures.mjs`
- Modify: `package.json`
- Create: `docs/screenshots/06-chrome-load-unpacked.png`
- Create: `docs/screenshots/07-extension-connect.png`
- Create: `docs/screenshots/08-extension-connected.png`
- Modify: `docs/screenshots/README.md`
- Test: `__tests__/docs/readme-user-guide.test.ts`

- [ ] **Step 1: Create the static Chrome Extensions instructional fixture**

Create a standalone HTML document with a neutral Chrome-like header, a visible **Developer mode** toggle, **Load unpacked** button, and one JobTracker extension card. Use only these synthetic values:

```html
<button class="primary">Load unpacked</button>
<span class="toggle on" aria-label="Developer mode enabled"></span>
<article class="extension-card">
  <div class="extension-icon">J</div>
  <h2>JobTracker</h2>
  <p>Extract job posting data and send it to JobTracker</p>
  <dl>
    <dt>ID</dt>
    <dd>abcdefghijklmnopabcdefghijklmnop</dd>
  </dl>
</article>
```

The complete document must use local CSS only, show a small banner reading “Instructional view — synthetic data”, fit a 1280×720 viewport, and contain no avatar, tabs, bookmarks, or external resource URLs.

- [ ] **Step 2: Add synthetic popup connection fixtures**

Append this export to `scripts/screenshot-fixtures.mjs`:

```js
export const popupConnectionFixture = {
  serverUrl: "http://localhost:3000",
  maskedToken: "••••••••••••••••••••••••••••••••",
  connectedStatus: "Connected to http://localhost:3000",
};
```

- [ ] **Step 3: Add setup-only routing to the screenshot script**

At module scope, add:

```js
const SETUP_ONLY = process.argv.includes("--setup-only");
const CHROME_SETUP_HTML_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "chrome-extensions-setup.html",
);
```

Import `popupConnectionFixture`. Add `captureChromeLoadUnpacked`, `captureExtensionConnect`, and `captureExtensionConnected` functions. The first loads the static fixture and captures the full 1280×720 page. The popup functions call `loadPopupPage(context)`, hide `#extracting`, `#form`, and `#noPage`, populate `#serverUrl`, and manipulate the actual connection controls as follows:

```js
// disconnected image
accessToken.value = popupConnectionFixture.maskedToken;
connectBtn.disabled = false;
disconnectBtn.disabled = true;
connectionStatus.textContent = "Disconnected — enter an access token to connect.";

// connected image
accessToken.value = "";
connectBtn.disabled = false;
disconnectBtn.disabled = false;
connectionStatus.textContent = popupConnectionFixture.connectedStatus;
connectionStatus.classList.add("success");
```

Capture the body to the exact filenames `06-chrome-load-unpacked.png`, `07-extension-connect.png`, and `08-extension-connected.png`.

Restructure `main()` so `assertDevServerUp()` and captures 01–05 run only when `SETUP_ONLY` is false. Captures 06–08 run in both modes. This makes the setup command independent of the app server and database.

- [ ] **Step 4: Add the package command**

Add this script without changing dependency versions:

```json
"screenshots:setup": "node scripts/screenshots.mjs --setup-only"
```

- [ ] **Step 5: Update screenshot regeneration notes**

Document:

````markdown
## Regenerating setup images only

The three installation and connection images use synthetic data and do not
require a running JobTracker server or database:

```bash
npm run screenshots:setup
```
````

List all eight filenames and state that 06–08 contain no real extension ID, access token, Chrome profile, or production origin.

- [ ] **Step 6: Verify GREEN and generate the PNGs**

Run:

```bash
npm run screenshots:setup
npx jest __tests__/docs/readme-user-guide.test.ts --runInBand
npm run check:extension
```

Expected: all three PNGs are generated; the documentation contract and extension checks pass.

- [ ] **Step 7: Inspect all three images**

Open each PNG and verify:

- 06 clearly highlights Developer mode, Load unpacked, JobTracker, and the synthetic extension ID.
- 07 shows the local URL, a masked token, Connect enabled, Disconnect disabled, and the disconnected status.
- 08 shows the local URL, an empty token field, Disconnect enabled, and the connected status.
- Text is not clipped at GitHub README width and no personal data appears.

- [ ] **Step 8: Commit the setup visuals**

```bash
git add package.json scripts/screenshots.mjs scripts/screenshot-fixtures.mjs \
  scripts/chrome-extensions-setup.html docs/screenshots/README.md \
  docs/screenshots/06-chrome-load-unpacked.png \
  docs/screenshots/07-extension-connect.png \
  docs/screenshots/08-extension-connected.png \
  __tests__/docs/readme-user-guide.test.ts
git commit -m "docs: add sanitized extension setup visuals"
```

### Task 3: Define the task-first README contract

**Files:**
- Modify: `__tests__/docs/readme-user-guide.test.ts`
- Test: `__tests__/docs/readme-user-guide.test.ts`

- [ ] **Step 1: Add a failing README structure and safety test**

Add this test to the same describe block:

```ts
it("guides a new user from local server setup to the first saved job", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const requiredHeadings = [
    "## How JobTracker Works",
    "## Prerequisites",
    "## Local Quick Start",
    "## Install the Chrome Extension",
    "## Connect the Extension",
    "## Save Your First Job",
    "## Set Up Resume Matching",
    "## Troubleshooting",
    "## Production Deployment",
    "## Development and Verification",
  ];
  const requiredText = [
    "Chrome extension → JobTracker server → PostgreSQL",
    "Node.js 22.22.2",
    "npm ci",
    "node:crypto",
    "APP_ACCESS_TOKEN",
    "chrome-extension://<extension-id>",
    "CORS_ALLOWED_ORIGINS",
    "chrome://extensions",
    "Load unpacked",
    "The extension is not standalone",
    "The token field is cleared after a successful connection",
    "docs/operations/production-runbook.md",
  ];

  for (const heading of requiredHeadings) expect(readme).toContain(heading);
  for (const text of requiredText) expect(readme).toContain(text);
  for (const image of setupImages) {
    expect(readme).toContain(`docs/screenshots/${image}`);
  }

  expect(readme).not.toContain("GENERATE_WITH_OPENSSL_RAND_BASE64_32");
  expect(readme).not.toMatch(/APP_ACCESS_TOKEN="(?!<|your-|second-|generated-)[^"]+"/u);
});
```

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
npx jest __tests__/docs/readme-user-guide.test.ts --runInBand
```

Expected: FAIL because the existing README does not have the task-first headings or new image references.

### Task 4: Rewrite README.md as the complete English user guide

**Files:**
- Modify: `README.md`
- Test: `__tests__/docs/readme-user-guide.test.ts`
- Test: `__tests__/docs/operations-docs-contract.test.ts`
- Test: `__tests__/ci/workflow-contract.test.ts`

- [ ] **Step 1: Replace the opening with a product and architecture orientation**

Use this exact section order:

```markdown
# JobTracker
## What You Can Do
## How JobTracker Works
## Prerequisites
## Local Quick Start
## Install the Chrome Extension
## Connect the Extension
## Save Your First Job
## Set Up Resume Matching
## Optional Features
## Troubleshooting
## Production Deployment
## Database Migration Notes
## Development and Verification
## Documentation
## License
```

Keep the dashboard and five existing product images near their relevant tasks. State prominently: “The extension is not standalone. It connects to your JobTracker server, which stores data in PostgreSQL.” Include the plain-text flow `Chrome extension → JobTracker server → PostgreSQL`.

- [ ] **Step 2: Write the copyable local setup**

Use only verified commands:

```bash
git clone https://github.com/taejunoh/easy-job-application-tracker.git
cd easy-job-application-tracker
npm ci
node -e "require('node:fs').copyFileSync('.env.example', '.env')"
```

Generate each of the two secrets separately with a cross-platform Node command:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Explain the five variables in a table and show this synthetic local template:

```dotenv
DATABASE_URL="postgresql://<db-user>:<db-password>@127.0.0.1:5432/<db-name>"
ENCRYPTION_SECRET="<first-generated-secret>"
APP_ACCESS_TOKEN="<second-generated-secret>"
APP_BASE_URL="http://localhost:3000"
CORS_ALLOWED_ORIGINS="http://localhost:3000,chrome-extension://<extension-id>"
```

Explain that the extension ID is added after loading the unpacked extension and that the development server must be restarted after `.env` changes. Use:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npm run dev
```

Then direct the user to `http://localhost:3000/connect`, where they enter the same `APP_ACCESS_TOKEN`.

- [ ] **Step 3: Write the image-led extension connection journey**

Place image 06 immediately after the Load unpacked and extension-ID steps. Place image 07 next to the URL/token/Connect steps and image 08 next to the expected successful state. Explain:

- Use the repository's `extension/` directory.
- Copy the 32-character unpacked extension ID.
- Add its exact `chrome-extension://` origin to the CORS list.
- Pin the extension, enter `http://localhost:3000`, paste `APP_ACCESS_TOKEN`, and select Connect.
- Approve only the requested server-site access.
- The token field is cleared after a successful connection by design.
- Disconnect revokes the stored credential and requested server permission; Chrome may display the origin until cleanup finishes.

- [ ] **Step 4: Write the first-job, resume, and optional-feature journeys**

Keep each as a short numbered task. Include supported job boards from `manifest.json`, manual field correction before save, dashboard confirmation, PDF/text resume upload, **Save Settings**, **Analyze Keywords**, profile autofill, and optional OpenAI/Gemini/Anthropic fallback extraction. Do not imply that an LLM key is required for basic metadata extraction.

- [ ] **Step 5: Add symptom-first troubleshooting**

Use a three-column table with these rows and concrete safe actions:

| Symptom | Likely cause | What to do |
|---|---|---|
| No permission prompt | Permission was already decided or the URL did not change | Verify the exact server URL, select Connect again, then inspect the extension Details page |
| Disconnected after token entry | Token or server URL was rejected | Compare with `APP_ACCESS_TOKEN`, confirm the server is running, and retry |
| Connection expired / 401 | Stored credential no longer matches the server | Disconnect, verify the server token, and reconnect |
| Server origin still listed | Permission cleanup is pending or Chrome is showing the granted-origin record | Complete Disconnect, reload the extension, and check the popup warning before manual removal |
| Could not extract | Dynamic page content was not ready | Wait for the posting to finish loading and select Re-extract |
| Save Application fails | Extension is disconnected or the API is unavailable | Confirm Connected status and open the tracker URL |
| Analyze Keywords unavailable | Resume was not saved | Upload PDF/TXT, select Save Settings, and reopen the popup |
| Prisma migration fails | Database URL, reachability, or schema history is wrong | Stop, back up existing data, validate the URL, and follow Database Migration Notes |
| Startup rejects `.env` | A placeholder, origin, or secret is invalid | Replace every placeholder and use exact origins without wildcard or path |

Do not recommend database reset, Chrome profile deletion, or removal of user data.

- [ ] **Step 6: Preserve concise advanced contracts**

Retain the exact phrases required by existing tests for Vercel build-time and request-serving validation, `npm start` self-hosted behavior, Chrome extension E2E commands, PostgreSQL 17 disposable database, and runbook links. Move verbose destructive-test guard details to links while keeping the non-production database warning and a short local CI reproduction note.

- [ ] **Step 7: Run README contract tests and verify GREEN**

Run:

```bash
npx jest __tests__/docs/readme-user-guide.test.ts \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/ci/workflow-contract.test.ts --runInBand
```

Expected: all suites pass with no snapshots.

- [ ] **Step 8: Commit the README rewrite**

```bash
git add README.md __tests__/docs/readme-user-guide.test.ts
git commit -m "docs: add task-first JobTracker user guide"
```

### Task 5: Final verification and handoff

**Files:**
- Verify: `README.md`
- Verify: `docs/screenshots/*.png`
- Verify: `docs/screenshots/README.md`
- Verify: `scripts/screenshots.mjs`
- Verify: `package.json`

- [ ] **Step 1: Verify Markdown paths and npm commands**

Run a small read-only Node check that extracts local Markdown targets from `README.md`, verifies each path exists, and compares every documented `npm run <name>` command against `package.json.scripts`. Expected: zero missing paths and zero unknown scripts.

- [ ] **Step 2: Run static and documentation verification**

```bash
npm run check:extension
npm run lint
npm run typecheck
npx jest __tests__/docs/readme-user-guide.test.ts \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/ci/workflow-contract.test.ts --runInBand
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Verify privacy and repository scope**

Search the README, setup HTML, screenshot generator, fixture source, and screenshot documentation for the production origin, real extension ID, bearer credentials, local absolute paths, and common token prefixes. Confirm the only extension ID is `abcdefghijklmnopabcdefghijklmnop` and all connection values are synthetic.

Confirm the isolated worktree contains only intended README, docs, test, screenshot-tool, package-script, and PNG changes. Confirm the original `main` checkout still has exactly the pre-existing 65 untracked files.

- [ ] **Step 4: Commit any verification-only corrections**

If verification required a documentation-only correction, stage only that exact file and commit:

```bash
git commit -m "docs: correct README verification details"
```

If no correction was required, do not create an empty commit.
