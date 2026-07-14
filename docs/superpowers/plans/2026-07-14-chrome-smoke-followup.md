# Chrome Smoke Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix popup Unicode rendering, normalize only a trailing Lever `logo` label, and document the verified Chrome 150 cleanup semantics.

**Architecture:** Keep the extension's connection, permission, and credential logic unchanged. Add one HTML encoding declaration, one private Lever-only string normalizer after the existing company-source selection, and documentation contract coverage for the observed system-Chrome behavior.

**Tech Stack:** Manifest V3 Chrome extension, plain JavaScript/HTML, Jest with ts-jest, Playwright extension E2E, GitHub pull requests

---

## File map

- Create `__tests__/extension/popup-html.test.ts`: static contract for popup encoding placement.
- Modify `extension/popup.html`: declare UTF-8 as the first `<head>` child.
- Modify `__tests__/extension/content.test.ts`: exercise Lever extraction through the actual registered message listener.
- Modify `extension/content.js`: normalize only a non-empty trailing `logo` token in Lever company labels.
- Modify `__tests__/docs/operations-docs-contract.test.ts`: require the observed Chrome cleanup semantics.
- Modify `docs/operations/chrome-extension-smoke.md`: document token-input, reload, toggle, and warning interpretation.

### Task 1: Declare popup UTF-8 encoding

**Files:**
- Create: `__tests__/extension/popup-html.test.ts`
- Modify: `extension/popup.html:3-5`

- [ ] **Step 1: Write the failing popup HTML contract**

Create `__tests__/extension/popup-html.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const popupHtml = readFileSync(
  join(process.cwd(), "extension/popup.html"),
  "utf8",
);

describe("popup HTML document contract", () => {
  it("declares UTF-8 as the first head child", () => {
    expect(popupHtml).toMatch(/<head>\s*<meta charset="UTF-8">/iu);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --runInBand __tests__/extension/popup-html.test.ts
```

Expected: FAIL because `<head>` is followed directly by `<style>`.

- [ ] **Step 3: Commit the regression test**

```bash
git add __tests__/extension/popup-html.test.ts
git commit -m "test: reproduce popup encoding omission"
```

- [ ] **Step 4: Add the minimal charset declaration**

Make the start of `extension/popup.html` exactly:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
```

- [ ] **Step 5: Run the focused test and verify GREEN**

```bash
npm test -- --runInBand __tests__/extension/popup-html.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 6: Commit the implementation**

```bash
git add extension/popup.html
git commit -m "fix: declare popup UTF-8 encoding"
```

### Task 2: Normalize Lever presentation labels

**Files:**
- Modify: `__tests__/extension/content.test.ts`
- Modify: `extension/content.js:232-240`

- [ ] **Step 1: Add a real listener-driven Lever extraction helper and cases**

Add this helper after `contentScript` in `__tests__/extension/content.test.ts`:

```ts
function extractLeverCompany(ogSiteName: string, logoAlt: string): string {
  const addListener = jest.fn();
  const sendResponse = jest.fn();
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener },
      },
    },
    document: {
      querySelector: jest.fn((selector: string) => {
        if (selector === ".posting-headline h2") {
          return { textContent: "Software Engineer" };
        }
        if (selector === ".main-header-logo img") {
          return { alt: logoAlt };
        }
        if (selector === 'meta[property="og:site_name"]') {
          return { getAttribute: () => ogSiteName };
        }
        return null;
      }),
      querySelectorAll: jest.fn(() => []),
    },
    window: {
      location: {
        hostname: "jobs.lever.co",
        href: "https://jobs.lever.co/example/software-engineer",
      },
    },
  });

  new vm.Script(contentScript).runInContext(context);
  const listener = addListener.mock.calls[0][0];
  listener({ action: "extractJob" }, {}, sendResponse);

  return (sendResponse.mock.calls[0][0] as { company: string }).company;
}
```

Add this test inside the existing `describe` block:

```ts
it.each([
  ["Olo logo", "Ignored logo", "Olo"],
  ["Acme LOGO", "", "Acme"],
  ["Logo Design Inc.", "", "Logo Design Inc."],
  ["Logo", "", "Logo"],
  ["", "Olo logo", "Olo"],
])(
  "normalizes the Lever company label %p without over-matching",
  (ogSiteName, logoAlt, expected) => {
    expect(extractLeverCompany(ogSiteName, logoAlt)).toBe(expected);
  },
);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --runInBand __tests__/extension/content.test.ts
```

Expected: FAIL for trailing `logo`/`LOGO` values while `Logo Design Inc.` and `Logo` remain unchanged.

- [ ] **Step 3: Commit the regression test**

```bash
git add __tests__/extension/content.test.ts
git commit -m "test: reproduce Lever logo company label"
```

- [ ] **Step 4: Implement the narrow normalizer**

Add immediately before `extractLever()` in `extension/content.js`:

```js
function normalizeLeverCompanyLabel(value) {
  const label = value.trim();
  const withoutLogo = label.replace(/\s+logo\s*$/i, "").trim();
  return withoutLogo || label;
}
```

Change the company assignment inside `extractLever()` to:

```js
const company = normalizeLeverCompanyLabel(
  ogSiteName || companyEl?.alt || ""
);
```

- [ ] **Step 5: Run the focused test and verify GREEN**

```bash
npm test -- --runInBand __tests__/extension/content.test.ts
```

Expected: PASS for all registration and Lever normalization cases.

- [ ] **Step 6: Commit the implementation**

```bash
git add extension/content.js
git commit -m "fix: normalize Lever company logo labels"
```

### Task 3: Document Chrome 150 cleanup semantics

**Files:**
- Modify: `__tests__/docs/operations-docs-contract.test.ts:98-135`
- Modify: `docs/operations/chrome-extension-smoke.md:91-111`

- [ ] **Step 1: Extend the runbook contract and verify RED**

Add these entries to the `normalizedSmokeRunbook` required-text array:

```ts
"visible token input is cleared",
"reload must remain disconnected",
"toggle must be off",
"cleanup warning",
```

Run:

```bash
npm test -- --runInBand __tests__/docs/operations-docs-contract.test.ts
```

Expected: FAIL because the four phrases are absent.

- [ ] **Step 2: Commit the documentation regression test**

```bash
git add __tests__/docs/operations-docs-contract.test.ts
git commit -m "test: require Chrome cleanup semantics"
```

- [ ] **Step 3: Add the observed semantics to the system-Chrome checklist**

After the popup-reopen step, add:

```markdown
   The visible token input is cleared after successful pairing by design; use
   the connected status and reopen restoration as the credential-retention
   checks rather than expecting the token to remain visible.
```

Replace the disconnect cleanup instruction with:

```markdown
7. Select **Disconnect** in the extension. Confirm no cleanup warning is shown,
   then reload the extension and confirm the popup reload must remain
   disconnected. In current Chrome, the exact runtime-requested origin may
   remain listed under Site access after removal; its toggle must be off. Mere
   presence in that list does not mean host access remains granted.
```

- [ ] **Step 4: Run the focused test and verify GREEN**

```bash
npm test -- --runInBand __tests__/docs/operations-docs-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the runbook update**

```bash
git add docs/operations/chrome-extension-smoke.md
git commit -m "docs: clarify Chrome extension cleanup checks"
```

### Task 4: Verify the complete change

**Files:**
- Verify all files changed by Tasks 1-3.

- [ ] **Step 1: Run focused extension suites**

```bash
npm test -- --runInBand __tests__/extension/popup-html.test.ts __tests__/extension/content.test.ts __tests__/extension/popup.test.ts __tests__/extension/popup-lifecycle.test.ts
```

Expected: all focused suites pass.

- [ ] **Step 2: Run extension syntax and manifest checks**

```bash
npm run check:extension
```

Expected: exit code 0.

- [ ] **Step 3: Run the full Jest suite**

```bash
npm test -- --runInBand
```

Expected: all tracked Jest suites pass. Do not add or modify the pre-existing numbered duplicate files.

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

Expected: exit code 0 with no new errors.

- [ ] **Step 5: Run the isolated extension E2E journey**

```bash
npm run test:extension:e2e:local
```

Expected: the complete disposable-database extension journey passes and removes its temporary database.

### Task 5: Review, publish, and merge

**Files:**
- Publish: `codex/chrome-smoke-followup`
- Merge into: `main`

- [ ] **Step 1: Obtain independent spec and code-quality approval**

Review `origin/main...HEAD` against the approved design. Resolve every issue, rerun affected tests, and obtain final approval before publishing.

- [ ] **Step 2: Push and open a ready pull request**

```bash
git push -u origin codex/chrome-smoke-followup
gh pr create --base main --head codex/chrome-smoke-followup --fill
```

Expected: branch push and PR creation succeed.

- [ ] **Step 3: Wait for checks and merge**

```bash
gh pr checks --watch
gh pr merge --merge --delete-branch
```

Expected: all required checks pass and the PR merges into `main`.

- [ ] **Step 4: Fast-forward the original checkout and prune the linked worktree**

```bash
git -C /Users/taejunoh/Desktop/LFG/easy-job-application-tracker switch main
git -C /Users/taejunoh/Desktop/LFG/easy-job-application-tracker pull --ff-only
git -C /Users/taejunoh/Desktop/LFG/easy-job-application-tracker worktree remove .worktrees/chrome-smoke-followup
git -C /Users/taejunoh/Desktop/LFG/easy-job-application-tracker branch -d codex/chrome-smoke-followup
```

Expected: local and remote `main` match at the merged commit.

### Task 6: Perform non-destructive system-Chrome verification

**Files:**
- Verify: unpacked extension loaded from `/Users/taejunoh/Desktop/LFG/easy-job-application-tracker/extension`

- [ ] **Step 1: Reload the exact installed extension**

Confirm extension ID `gihbagcjnmkhkekjkbfjhcbddnamaiap` and click the reload icon in `chrome://extensions`.

- [ ] **Step 2: Verify popup text and Lever extraction**

Open the reviewed Olo posting, click the real JobTracker toolbar icon, and confirm:

- disconnected status renders an em dash (`—`) without mojibake;
- company extracts as `Olo`, not `Olo logo`.

Do not reconnect or save another production row for this visual/extraction-only verification.

- [ ] **Step 3: Record the result**

Report pass/fail, merged commit, extension ID, focused/full/E2E test results, and Chrome verification. Do not record credentials or job description content.
