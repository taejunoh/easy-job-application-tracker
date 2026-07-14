# Chrome Extension E2E and Production Smoke Runbook

This runbook separates the destructive, isolated browser automation from the
manual system Chrome verification required for a production release. Never
copy an application access token, saved application row, resume content, or
API response body into logs, screenshots, tickets, or release evidence.

## Automated bundled-Chromium scope

`npm run test:extension:e2e:local` creates the exact disposable PostgreSQL 17
database `jobtracker_extension_e2e_test`, builds the application, runs the E2E
journey, and removes the database. CI supplies the same prerequisites and runs
`npm run test:extension:e2e` directly. Both commands use Playwright's bundled
Chromium with an isolated temporary profile; neither command launches system
Chrome or touches an installed user extension.

The automation discovers the temporary extension ID at runtime and drives the
actual Chrome action popup. It covers the disconnected state, invalid token
rejection, valid pairing, deterministic Lever extraction, application save,
exact SQL verification, keyword analysis, popup close and reopen connection
restoration, explicit disconnect, and server-`401` credential and permission
cleanup.

After valid pairing, the runner uses the CDP ServiceWorker domain to identify
the exact MV3 service worker registration and running version, stop the old
worker, prove its target disappeared, and wake a new worker target. Chromium's
extension registration does not expose a reliable `ServiceWorker.startWorker`
target in this harness, so the isolated profile uses
`chrome.developerPrivate.openDevTools` as the wake equivalent, attaches to the
new worker, closes the temporary DevTools window, and opens the actual action
popup from that new worker. The test then proves the popup is connected, the
token input is empty, and the stored credential and exact host permission were
retained across the MV3 service worker stop and restart. This does not perform
a full extension reload.

The checked-in extension manifest is not modified. The disposable extension
copy narrows the optional server permission to the exact loopback test origin
and adds only `https://jobs.lever.co/*` as a required fixture permission. This
temporary fixture permission is needed because a programmatically opened action
popup does not receive a user toolbar click's `activeTab` grant. The extension
still calls its real optional server permission request, and the test asserts
that the permission is absent after invalid pairing, disconnect, and `401`.

Headless Chromium cannot approve its own browser-chrome permission prompt. The
runner therefore invokes `chrome.developerPrivate.addHostPermission` only
inside the isolated temporary profile and only for the exact loopback server
pattern before exercising the extension's real permission request. It must
never use this private API against a user profile, a broad host pattern, or a
non-loopback server.

Failure evidence is deliberately minimal and redacted: a screenshot and JSON
metadata containing only the failed step, browser version, dynamic extension
ID, and failure class. Before any screenshot, the runner clears and hides the
analysis result, keyword pills and summary, every input and textarea, links,
datasets, and fixture-derived DOM, then rejects capture unless the sanitized
DOM snapshot contains none of the fixture or credential markers. The runner
records no HAR or trace and must never write tokens, authorization headers,
database URLs, job row contents, or resume contents to an artifact.

Popup close and reopen is automated within one temporary profile. A full
extension reload is intentionally a system Chrome smoke step because Chromium
does not expose the user toolbar interaction and reload behavior faithfully to
this headless action-popup harness.

## Production system Chrome smoke

Run this checklist after CI is green and the reviewed release is deployed to
the canonical origin
`https://easy-job-application-tracker.vercel.app`. The currently verified
installed extension ID is `gihbagcjnmkhkekjkbfjhcbddnamaiap`; stop if the
installed ID differs from the exact extension origin approved in production
`CORS_ALLOWED_ORIGINS`.

Preconditions:

- Use a dedicated operator Chrome profile with no unrelated JobTracker data.
- Have the production access credential available through the approved secret
  channel without putting it in shell history, notes, or evidence.
- Open a real, reviewed job posting that may be removed after the check, and
  choose a unique marker for the temporary application so cleanup can be
  proven without recording sensitive row content.
- Keep DevTools network export, HAR capture, trace capture, and extension debug
  logging disabled.

Perform the smoke:

1. Open `chrome://extensions`, locate the exact installed ID above, and select
   **Reload** for the unpacked extension. This is the required full extension
   reload check.
2. Navigate to the job posting, click the real JobTracker toolbar icon, and
   confirm the actual toolbar click supplies `activeTab` extraction access.
3. Enter the canonical origin and an intentionally invalid token. Approve the
   exact optional host permission if Chrome asks, confirm pairing is rejected,
   and confirm the permission is removed rather than retained.
4. Enter the valid credential through the popup and approve only the exact
   canonical-origin permission. Confirm extraction completed, add the unique
   marker, save the application, and verify it appears once in the production
   dashboard.
5. Close the popup, click the toolbar icon again, and confirm popup reopen
   connection restoration without entering the credential again.
6. Delete the temporary application from the dashboard and confirm the unique
   marker no longer appears.
7. Select **Disconnect** in the extension. Confirm credential cleanup in
   extension storage and exact canonical-origin permission cleanup in the
   browser's extension permissions.

Cleanup is unconditional, including when an earlier step fails: delete the
unique-marker row, disconnect the extension, remove the exact site permission,
and clear any stored production credential from the dedicated profile. Do not
close the release until row cleanup, permission cleanup, and credential cleanup
are each confirmed. Record only pass/fail status, release identity, extension
ID, and timestamps; do not record the token, row, or resume.
