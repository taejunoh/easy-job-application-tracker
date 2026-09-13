# Focused Journal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh JobTracker into the approved warm, focused journal UI while retaining every existing client/server behavior and request contract.

**Architecture:** Keep the existing Next client components and Tailwind 4 setup; apply a small set of CSS tokens and reuse the current data-fetching/mutation helpers. Keep exactly one `UrlInputWrapper` inside one always-mounted `AppShell` Add panel: it is open on Dashboard and toggled on other non-Connect routes, so route changes and panel close never discard its draft/confirmation state. Presentation changes must not change routes, request bodies, query parameters, auth/session behavior, feature gates, or database/provider behavior.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Jest + Testing Library, existing Playwright fixture data (inspection only), CUA browser for final visual review.

---

## Fixed boundaries

- Do not edit `src/app/api/**`, `src/lib/**`, `src/proxy.ts`, Prisma files, env validation, auth/session code, or extraction/identity/write semantics.
- `validationManualEntryEnabled` remains the sole Manual gate and is `false` by default. `RootLayout` passes it only to `AppShell`, which passes it directly to the single Add panel and its existing `UrlInputWrapper`.
- Preserve exact request contracts: Dashboard uses only `/api/stats`; Applications uses only `search`, `status`, and `jobType`; create uses the existing `/api/extract` and `/api/applications` request bodies; detail uses the existing settings GET and application PATCH/DELETE bodies.
- Do not add a UI package, icon library, font request, data framework, API, migration, sort, dashboard filter, pagination, Kanban, or drag/drop behavior.
- The existing global Add input stays shell-owned as one always-mounted instance. Dashboard exposes it open as its primary card; Applications, detail, and Settings expose its explicit `Add application` toggle. Connect remains shell-free and deliberately gets no Add action.

## File map

| File | Responsibility |
| --- | --- |
| `src/app/globals.css` | Warm canvas, semantic color/type/focus/44px control tokens and shared utility classes. |
| `src/components/AddApplicationPanel.tsx` (new) | Single always-mounted shell panel around the existing URL input wrapper; route controls only its visibility. |
| `src/components/AppShell.tsx`, `Sidebar.tsx` | Narrow desktop rail, nonmodal mobile navigation, and the single persistent Add panel. |
| `src/components/UrlInput.tsx`, `StatCard.tsx`, `StatusBadge.tsx` | Accessible add modes and tokenized reusable metric/status rendering. |
| `src/app/page.tsx` | Dashboard-only Add card, six metrics, noninteractive status summary, recent list. |
| `src/app/applications/page.tsx`, `src/components/ApplicationTable.tsx` | List-adjacent filters, desktop table and equivalent mobile cards. |
| `src/components/ApplicationDetail.tsx`, `src/app/settings/page.tsx`, `src/app/connect/page.tsx`, `src/components/ExtensionInstallations.tsx` | Detail hierarchy and visual compatibility for the remaining surfaces without changing their behavior. |
| `__tests__/components/*.test.ts`, `__tests__/connect.test.ts` | Behavioral DOM/interaction tests. Replace in-scope raw-source-string assertions rather than adding any. |

### Task 1: Tokenized shell, state-preserving Add panel, and Dashboard

**Files:**

- Create: `src/components/AddApplicationPanel.tsx`
- Create: `__tests__/components/sidebar.test.ts`
- Create: `__tests__/components/add-application-panel.test.ts`
- Create: `__tests__/components/dashboard.test.ts`
- Modify: `src/app/globals.css`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/UrlInput.tsx`
- Modify: `src/components/StatCard.tsx`
- Modify: `src/components/StatusBadge.tsx`
- Modify: `src/app/page.tsx`
- Modify: `__tests__/components/app-shell.test.ts`
- Modify: `__tests__/components/url-input.test.ts`

- [ ] **Step 1: Write the failing shell/add/dashboard behavior tests.**

  In `sidebar.test.ts`, render the real sidebar with a mocked pathname and assert active Applications has `aria-current="page"`; the mobile menu trigger has `aria-controls="primary-navigation"` and changes `aria-expanded`; Escape closes it and focuses the same trigger. Assert the desktop and mobile links have accessible names. The filled active state and absence of a yellow left stripe are checked in the CUA visual pass, not through implementation-text assertions.

  In `add-application-panel.test.ts`, render `AppShell` with the real panel and mocked `UrlInput` dependencies. Type a URL on Dashboard, rerender the shell at `/applications`, open then close/reopen its Add control, and assert the same input value remains throughout. Assert its trigger controls a named region. Render with `manualEntryEnabled={false}` and assert `Manual` is absent; render with `true` and assert it is present. Target dimensions are checked in the CUA visual pass.

  In `dashboard.test.ts`, mock `useClientApi` to resolve the six-field stats fixture and assert `aria-busy` clears, the six labels and the four labelled status/count summaries render, Recent Applications shows title/company/date/status text, and a zero-result response shows first-application guidance referring to the shell-owned Add application card. Reject the stats request and assert the inline alert appears while dashboard content remains rendered.

  Update `app-shell.test.ts` to assert non-Connect pages render one shell main and one persistent Add panel containing `UrlInputWrapper`; retain the bare single-main Connect assertion. Update `url-input.test.ts` to assert URL/Paste Text/conditional Manual are actual `role="tab"` controls with `aria-selected` and `aria-controls`, arrow/Home/End navigation, while retaining the existing API-body/manual-validation tests.

- [ ] **Step 2: Run the focused tests and confirm they fail for missing behavior.**

  Run:

  ```bash
  npm test -- --runInBand __tests__/components/app-shell.test.ts __tests__/components/sidebar.test.ts __tests__/components/add-application-panel.test.ts __tests__/components/dashboard.test.ts __tests__/components/url-input.test.ts
  ```

  Expected: failures identify the absent persistent panel, mobile nav keyboard handling, Dashboard structure, and tab semantics; existing request-contract tests stay green.

- [ ] **Step 3: Add the smallest shared plumbing.**

  In `AppShell`, keep one `<main>` and one `UrlInputWrapper` through a single `AddApplicationPanel`; do not add context or page-owned copies. Keep the panel mounted for every non-Connect pathname, pass the existing `manualEntryEnabled` prop directly to it, and use a document-flow two-column shell (`aside` is a narrow rail, not `fixed`). Keep the existing `/connect` early return unchanged.

  Add `AddApplicationPanel` with these exact props:

  ```ts
  type AddApplicationPanelProps = {
    alwaysOpen?: boolean;
    manualEntryEnabled: boolean;
    panelId: string;
  };
  ```

  In `AppShell`, pass `alwaysOpen={pathname === "/"}` and one stable `panelId="global-add-application"`. `AddApplicationPanel` renders an `Add application` heading/card and its input directly when `alwaysOpen`; otherwise it renders the `Add application` button with `aria-expanded`/`aria-controls` and its named region. Hide the region with CSS/`hidden`; never conditionally unmount `UrlInputWrapper` or reset state when `pathname` changes, so closing or navigating cannot discard URL, text, manual, confirmation, alert, or notice state.

- [ ] **Step 4: Implement the shared visual/accessibility system and shell.**

  In `globals.css`, define the approved tokens exactly: canvas `#f6f5ef`, ink/primary `#24483e`, surface `#ffffff`, border `#d9ddd5`, text `#23352e`, muted `#526259`, destructive `#a12c32`; set the body to canvas/text and sans font; add a page-heading serif stack of `Georgia, 'Times New Roman', serif`. Define shared card, field, secondary button, primary button, destructive button, status badge, and `:focus-visible` rules using these tokens. Every button/input/select/link used by this task gets `min-height: 44px` (or a shared 44px class); focus outlines use deep green plus an offset that remains visible on canvas and surface.

  Rebuild `Sidebar` as a client-controlled `<aside>`: desktop shows the narrow rail; mobile shows a 44px Menu trigger and a document-flow `<nav id="primary-navigation">`. Use a trigger ref and an Escape key effect scoped to the open menu to set closed and return focus. Do not trap focus. Keep current-path matching and add `aria-current="page"`; active style is filled deep green with light text/icon only—no left stripe. Use text labels if no existing icon system is present.

  Convert `UrlInput` mode controls to a tablist with three buttons, stable panel ids, keyboard-native button behavior, `aria-selected`, `aria-controls`, and preserved loading/alert/status logic. Restyle only; do not alter its extract/save handlers, validation, clearing rules, or messages. Update `StatCard` to render label and value without color-only meaning; update `StatusBadge` to render the exact English status plus distinct semantic class/border/icon treatment for Applied, Interview, Offer, and Rejected.

- [ ] **Step 5: Recompose Dashboard without changing its data source.**

  In `src/app/page.tsx`, keep the one `/api/stats` effect and `Stats` shape. Render the page heading and rely on the AppShell's always-open Add application card; do not add a dashboard search/filter/control or another input instance. Avoid early-returning on fetch error: retain dashboard content, set `aria-busy` around the content, and show the existing-meaning alert inline.

  Render all six existing metrics: Interviewing and Offers in the first compact primary pair; Total Applied, Rejected, This Week, and This Month in a denser supporting group. Replace the color-only bar/legend with a non-clickable four-item summary, each containing `StatusBadge` text and its count. Keep `recentApplications` as title, company, localized applied date, and `StatusBadge`; its empty copy must direct the user to the Add card rather than imply an invented list filter.

- [ ] **Step 6: Run the task suite and static checks.**

  Run:

  ```bash
  npm test -- --runInBand __tests__/components/app-shell.test.ts __tests__/components/sidebar.test.ts __tests__/components/add-application-panel.test.ts __tests__/components/dashboard.test.ts __tests__/components/url-input.test.ts
  npm run lint
  npm run typecheck
  ```

  Expected: all pass; no API route, payload, or gate test changes are required.

### Task 2: Applications filters and responsive list presentation

**Files:**

- Create: `__tests__/components/application-table.test.ts`
- Create: `__tests__/components/applications-page.test.ts`
- Modify: `src/app/applications/page.tsx`
- Modify: `src/components/ApplicationTable.tsx`
- Modify: `__tests__/components/applications-latest.test.ts`

- [ ] **Step 1: Write failing rendered behavior tests (not source-text tests).**

  In `application-table.test.ts`, supply one application and assert the desktop semantic table has exactly the six column headers `Job Title`, `Company`, `Status`, `Date Applied`, `Location`, and `Type`; assert title/company come before metadata. Assert the mobile card representation exposes the same six values, with title/company/status/date before location/type. Click/press Enter on a row/card navigation target and assert `router.push('/applications/app-1')`; click/change its native status select and assert only `onStatusChange('app-1', 'Interview')`, never row navigation.

  In `applications-page.test.ts`, mock `useClientApi` with resolved fixture data, use the real page, and assert the labelled search/select controls issue exactly `/api/applications?search=Engineer&status=Interview&jobType=Remote`; assert an API rejection displays an alert while the entered search and both selected filters remain. Cover the visible Add button and route/close/reopen draft retention in the shell panel test, not with a page-owned panel.

  In `applications-latest.test.ts`, remove the `readFileSync`/class-string test. Keep its race tests and add a behavioral assertion through `loadLatestApplications` that only the last request clears `aria-busy` state via its supplied setter; do not inspect source code.

- [ ] **Step 2: Run those tests before implementation.**

  Run:

  ```bash
  npm test -- --runInBand __tests__/components/application-table.test.ts __tests__/components/applications-page.test.ts __tests__/components/applications-latest.test.ts
  ```

  Expected: failures for missing panel/filter labels, mobile cards, keyboard row navigation, and behavior-only replacement assertions; the existing stale-request helper tests remain green.

- [ ] **Step 3: Add the list-adjacent controls and preserve query/race behavior.**

  In `ApplicationsPage`, retain its page heading; the AppShell provides the one explicit Add application toggle. Keep `search`, `statusFilter`, `jobTypeFilter`, `refreshRevision`, `requestSequence`, `mounted`, `loadLatestApplications`, and `updateApplicationStatus` logic intact. Add explicit accessible labels (visually hidden is acceptable) and shared field classes. Lay out search then the two native selects in one desktop filter bar immediately adjacent to the result list; stack them at `max-width: 768px`. Build the URL with the identical three current parameters and values—no debounce, sort, pagination, or new query parameter.

  Keep `aria-busy={loading}` and the inline alert. Never clear user-entered filter state in the error branch. Status PATCH must still schedule refresh only after it resolves and must re-fetch using the latest committed filter values.

- [ ] **Step 4: Render one data model in desktop and mobile forms.**

  In `ApplicationTable`, keep the desktop `<table>` semantic and six current fields at `md` and above. Make the table row focusable/clickable with Enter and Space navigation; ensure the select stops both click and key propagation, uses the existing four status values, has an associated accessible name, and has a 44px target.

  Add a `md:hidden` card list that maps the same application array without dropping data: its primary actionable area contains job title and company; status and applied date follow; Location and Type appear as labelled secondary metadata. Its status select uses the same `onStatusChange` contract and event isolation. Give the no-result card copy an `Add application` button/panel reference, preserving the existing first-URL guidance and not claiming dashboard filtering.

- [ ] **Step 5: Run focused and regression tests.**

  Run:

  ```bash
  npm test -- --runInBand __tests__/components/application-table.test.ts __tests__/components/applications-page.test.ts __tests__/components/applications-latest.test.ts __tests__/components/client-mutations.test.ts
  npm run lint
  npm run typecheck
  ```

  Expected: all pass, including stale-request and PATCH-refresh behavior; request paths/bodies remain byte-for-byte equivalent to the current contract.

### Task 3: Detail hierarchy and Settings/Connect compatibility

**Files:**

- Create: `__tests__/components/application-detail-ui.test.ts`
- Modify: `src/components/ApplicationDetail.tsx`
- Modify: `src/app/settings/page.tsx`
- Modify: `src/app/connect/page.tsx`
- Modify: `src/components/ExtensionInstallations.tsx`
- Modify: `__tests__/components/extension-installation-settings.test.ts`
- Modify: `__tests__/connect.test.ts`

- [ ] **Step 1: Write failing DOM and interaction tests.**

  In `application-detail-ui.test.ts`, mock the client API/settings response and router, render a full application, and assert the title/company/status select appear before the compact metadata group; metadata includes Date Applied, Location, Salary Range, and Job Type; Job Description, Keyword Match Analysis, Notes, and Source URL remain separately labelled. Assert opening/collapsing keyword analysis preserves percentage plus `Matched` and `Missing` text, and the no-resume message still links to Settings. Assert Save Changes shows `Saving...` then `Saved` on the existing PATCH body; delete displays confirmation and only navigates after the existing DELETE resolves. Verify narrow-layout columns and target geometry only in CUA, where CSS is actually applied.

  Replace raw `readFileSync` assertions in `extension-installation-settings.test.ts` with rendered behavior: the section has `id="extension-installations"`, shows an opaque installation id, and dismissing `PairingCodePanel` removes the one-time secret from the rendered output/state. In `connect.test.ts`, replace class-string assertions with DOM assertions for the labelled token field, one status live region, visible error text, and enabled/disabled Connect button state. Keep its exact token POST test unchanged.

- [ ] **Step 2: Run before implementation.**

  Run:

  ```bash
  npm test -- --runInBand __tests__/components/application-detail-ui.test.ts __tests__/components/client-mutations.test.ts __tests__/components/extension-installation-settings.test.ts __tests__/connect.test.ts
  ```

  Expected: failures isolate the new detail hierarchy and DOM behavior assertions, while all current mutation/auth contracts remain green.

- [ ] **Step 3: Reflow detail while retaining every field and mutation.**

  In `ApplicationDetail`, retain its page/detail header; the AppShell provides the one explicit Add application toggle. Keep Back, title/company editing, the four exact status options, form state, 300ms keyword debounce, keyword algorithm/thresholds, API URLs, serializers, `Saving...`/`Saved`, error handling, confirmation copy, DELETE navigation, and `role` attributes unchanged.

  Style the header so editable title/company and status are in the first viewport. Put Date Applied, Location, Salary Range, and Job Type in a compact metadata group (two columns at readable widths, one at 768px and below). Keep description, keyword analysis, notes, and source as separate sections; retain percentage text and labelled Matched/Missing badges in addition to color. Put Save Changes and its status at the content end with a clear screen position, then isolate Delete/confirmation using the destructive token. Ensure every form control/button has a label, focus-visible treatment, and 44px target; do not turn analysis into a different interaction model.

- [ ] **Step 4: Apply token compatibility only to Settings, Connect, and extension management.**

  Restyle `settings/page.tsx` and `ExtensionInstallations.tsx` with the shared surface/border/text/action classes, serif page heading, readable labels, and 44px controls. Do not change their sections, copy, provider values, upload handling, credential display behavior, pairing/revoke calls, state transitions, or deep-link id. Settings retains its page heading while the AppShell provides the existing Add capability as its explicit toggle; do not create another panel.

  Restyle `connect/page.tsx` as a compatible warm/surface access screen. Preserve its standalone layout, auto-focus, secure input properties, status/alert behavior, destination sanitization, exact auth POST, and no client persistence. Use deep green for the primary action/focus, tokenized destructive error styling, and at least 44px input/button targets; do not add the Add panel or any Settings functionality to Connect.

- [ ] **Step 5: Verify code and safe visual acceptance.**

  Run:

  ```bash
  npm test -- --runInBand __tests__/components/application-detail-ui.test.ts __tests__/components/client-mutations.test.ts __tests__/components/extension-installation-settings.test.ts __tests__/connect.test.ts __tests__/components/url-input.test.ts
  npm run lint
  npm run typecheck
  ```

  Then use CUA (not Playwright browser automation) for final visual inspection at 1440, 1024, 768, and 375 CSS px. `scripts/screenshots.mjs`, `scripts/screenshot-fixtures.mjs`, and `docs/screenshots/README.md` are the read-only reference: their `statsFixture`/`settingsFixture` prove the intended synthetic-data shape and their fixed UTC/en-US setup prevents date drift. Do not run them against a real server/database or alter those files for this feature.

  Start a local Next dev server only with fresh, throwaway development env values and `APPLICATION_WRITES_ENABLED=0`; put a short-lived local reverse proxy in front of it that (a) forwards pages/assets and `/api/auth/session`, (b) serves only synthetic responses for `/api/stats`, `/api/applications`, `/api/applications/:id`, `/api/settings`, and `/api/extract`, and (c) rejects every non-fixture write except the no-op synthetic extract/create responses needed to view confirmation. It must bind to localhost, keep fixture data in memory, and never forward API data routes upstream. Log and fail on an attempted database/provider request. Use the CUA browser to log in with the throwaway token, inspect Dashboard, Applications desktop/mobile, detail desktop/mobile, Settings, and Connect; interact with menu Escape/focus return, tabs, filters, panel close/reopen, confirmation, status select, Save/Delete confirmation without allowing real writes.

  Acceptance is visual only after the automated suite: at 1440 verify off-white canvas/deep-green rail/Add card/6 metrics/status summary; at 1024 verify uncut filter/table; at 768 verify document-flow mobile nav, stacked filters, and cards; at 375 verify no horizontal scroll and usable add confirmation/detail Save/Delete. Record only screenshots or observations from the synthetic local session—no DB, provider, deployment, or production write.

## Final regression command

```bash
npm test -- --runInBand
npm run lint
npm run typecheck
```

Expected: all existing API/auth/env/identity/write-stop tests remain unchanged and passing; this UI-only work introduces no migration, server route, request payload, or feature-gate difference.
