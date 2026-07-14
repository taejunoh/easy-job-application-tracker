# Chrome Extension End-to-End Design

## Goal

Exercise the real Manifest V3 extension in Chromium and the installed Chrome
profile so release confidence does not depend only on mocked `chrome.*` APIs.

## Considered Approaches

### A. Playwright persistent Chromium plus one installed-Chrome smoke

Use Playwright's bundled Chromium with a persistent context and the unpacked
extension for repeatable local/CI tests, then perform a small production smoke
with the user's installed Chrome extension. This is recommended because Chrome
and Edge no longer support the side-load flags Playwright needs, while bundled
Chromium does.

### B. Automate the user's normal Chrome profile for every test

This would reflect the exact browser but risks profile corruption, prompts,
unrelated tabs, and nondeterministic extension state. It is limited to the final
smoke test.

### C. Keep Jest VM tests only

The existing tests cover substantial logic but cannot prove host permission
prompts, trusted extension storage, MV3 service-worker lifecycle, or actual
network CORS behavior. This is rejected.

## Test Harness

A Node Playwright script launches `chromium.launchPersistentContext` with
`channel: "chromium"`, `--disable-extensions-except`, and `--load-extension`.
It discovers the extension ID from the MV3 service-worker URL rather than
hard-coding it. The test profile lives in a temporary directory and is removed
after the context closes.

The harness starts the app against a disposable PostgreSQL database. It first
launches the extension to discover its ID, then starts JobTracker with an exact
`chrome-extension://<id>` CORS origin. A routed Lever-style HTTPS fixture gives
the content script a deterministic supported job page without scraping a live
site.

## Required Journeys

1. Open the extension popup with no credentials and observe Disconnected state.
2. Enter the local JobTracker origin and token, click Connect as the user gesture
   for optional host permission, and observe Connected state.
3. Open the deterministic job fixture and verify extracted title, company,
   location, URL, and description.
4. Save the application and verify it through the authenticated API.
5. Seed resume text, run keyword analysis, and verify a rendered result.
6. Disconnect and verify credentials and host permission are removed.
7. Reconnect, force a `401`, and verify the extension invalidates credentials.
8. Exercise MV3 service-worker idle/restart behavior without losing the stored
   connection contract.

Every created row and temporary profile is removed even on failure.

## Production Smoke

The local Chrome profile currently maps the unpacked repository extension to
`gihbagcjnmkhkekjkbfjhcbddnamaiap`; this is verified again immediately before
configuring CORS. The production smoke pairs that installed extension to the
canonical HTTPS origin, saves one uniquely marked fixture, confirms it in the
web application, deletes it, disconnects, and confirms a denied origin remains
blocked.

The manifest has no `key`, so the installed ID is not treated as globally
portable. Publishing or reserving a Chrome Web Store ID is a separate external
release decision. Production allowlists only the currently verified installed
ID; other users must add their exact self-hosted extension origin.

## CI and Success Criteria

The deterministic Chromium E2E runs as a release gate after build and database
migration setup. Artifacts on failure contain screenshots and console/network
diagnostics but never tokens, resumes, job records, or database URLs.

Success requires all eight local journeys to pass, the production installed-
Chrome save/delete smoke to pass, unauthorized and disallowed-origin requests
to remain rejected, and no persistent test row, permission, or browser profile
to remain afterward.

## References

- Playwright Chrome extensions: https://playwright.dev/docs/chrome-extensions
- Neon restore window: https://neon.com/docs/manage/projects
