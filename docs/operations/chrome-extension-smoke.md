# Chrome Extension E2E and Production Smoke Runbook

This runbook separates the destructive, isolated browser automation from the
manual system Chrome verification required for a production release. Never
copy an application access token, pairing code, installation credential, saved
application row, resume content, or API response body into logs, screenshots,
tickets, or release evidence.

## Automated bundled-Chromium scope

`npm run test:extension:e2e:local` creates the exact disposable PostgreSQL 17
database `jobtracker_extension_e2e_test`, builds the application, runs the E2E
journey, and removes the database. CI supplies the same prerequisites and runs
`npm run test:extension:e2e` directly. Both commands use Playwright's bundled
Chromium with an isolated temporary profile; neither command launches system
Chrome or touches an installed user extension.

The automation discovers the temporary extension ID at runtime and drives the
actual Chrome action popup. It covers the disconnected state, invalid pairing
code rejection, origin-bound and expired code rejection, same-origin replay,
concurrent one-time consumption, valid pairing across two isolated
installations, deterministic Lever extraction, application save, exact SQL
verification, keyword analysis, popup close and reopen connection restoration,
explicit disconnect, and server-`401` credential and permission cleanup.

After valid pairing, the runner uses the CDP ServiceWorker domain to identify
the exact MV3 service worker registration and running version, stop the old
worker, prove its target disappeared, and wake a new worker target. Chromium's
extension registration does not expose a reliable `ServiceWorker.startWorker`
target in this harness, so the isolated profile uses
`chrome.developerPrivate.openDevTools` as the wake equivalent, attaches to the
new worker, closes the temporary DevTools window, and opens the actual action
popup from that new worker. The test then proves the popup is connected, the
pairing-code input is empty, and the stored credential and exact host permission were
retained across the MV3 service worker stop and restart. This does not perform
a full extension reload.

The checked-in extension manifest is not modified. The disposable extension
copy removes every inherited optional host pattern and sets only
`http://127.0.0.1:3100/*` as the optional server permission. Its required host
permissions contain only `https://jobs.lever.co/*` for the deterministic
fixture. This temporary fixture permission is needed because a programmatically
opened action popup does not receive a user toolbar click's `activeTab` grant.
The extension still calls its real optional server permission request, and the
test asserts that the permission is absent after invalid pairing, disconnect,
and `401`.

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
`CORS_ALLOWED_ORIGINS`. The system-Chrome evidence below was observed in
Chrome 150 (the verified version); do not generalize browser UI or Site access
behavior to other versions without re-verification.

Preconditions:

- Use a dedicated operator Chrome profile with no unrelated JobTracker data.
- Authenticate to the web app as an administrator, then open
  **Settings → Chrome extension installations**. Create each one-time pairing
  code only when its popup is ready; never reveal `APP_ACCESS_TOKEN` to the
  extension or record either secret in shell history, notes, or evidence.
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
3. Enter the canonical origin and an intentionally invalid pairing code. Approve the
   exact optional host permission if Chrome asks, confirm pairing is rejected,
   and confirm the permission is removed rather than retained.
4. In **Settings → Chrome extension installations**, select the installed
   extension's exact origin and create a fresh one-time pairing code. Enter that
   code through the popup and approve only the exact canonical-origin
   permission. Confirm extraction completed, add the unique
   marker, save the application, and verify it appears once in the production
   dashboard.
5. Close the popup, click the toolbar icon again, and confirm popup reopen
   connection restoration without entering another code. The visible
   pairing-code input is cleared after successful pairing by design; verify retention
   through connected status and reopen restoration, not visible code
   persistence.
6. Keep the paired popup/session available and complete the [revocation and
   consumed-code replay lifecycle](#revocation-and-consumed-code-replay-lifecycle)
   before using **Disconnect**. Do not use **Disconnect** as proof of server-side
   revocation: it deletes the local credential as part of local cleanup.
7. After the lifecycle, confirm the unique marker no longer appears in the
   dashboard. The only durable cleanup targets are the uniquely created smoke
   row and the exact smoke installation; leave no unrelated data changed.
8. If local cleanup is still pending after the lifecycle, select
   **Disconnect** and confirm no cleanup warning is shown in the popup
   connection-status area. Reload the extension in `chrome://extensions`,
   return to the job tab, and click the JobTracker toolbar icon. The reopened
   popup after reload must remain disconnected; confirm that it does. The exact
   runtime-requested origin may remain listed under Site access after removal
   in Chrome 150 (the verified version); its toggle must be off. Mere list
   presence does not mean host access remains granted.

### Revocation and consumed-code replay lifecycle

Run this lifecycle with the same dedicated profile and unique smoke data used
above. Keep the paired popup/session available until the server-side revoke and
the extension's 401 handling are both confirmed.

1. In the authenticated **Settings → Chrome extension installations** view,
   select the exact smoke installation created for this check and revoke the
   exact smoke installation server-side. Confirm the installation is marked
   revoked in Settings; do not
   use **Disconnect** as this confirmation because it deletes the local
   credential before the server-side check.
2. Trigger an extension authenticated request after revocation by reloading the
   extension in `chrome://extensions` and reopening the paired popup. Its
   startup `/api/auth/verify` request must receive `401`; confirm the popup shows
   the expired/disconnected state and that local credential cleanup (including
   the installation credential) completed. Do not expose or log the credential
   or response body.
3. After the 401 handler leaves the original extension disconnected and
   credential-free, keep using that original extension popup/profile for the
   replay check. Before entering the code, verify that its extension origin
   exactly equals the original approved origin (`chrome-extension://...`) and
   that the installed extension ID is unchanged. Do not reinstall/load another
   copy: this unpacked manifest has no stable key, so doing so changes the
   extension ID. If a second context is used for troubleshooting, it must
   preserve the exact same extension origin; an origin mismatch is invalid
   evidence.
4. In that same original extension popup/context, attempt to reuse the exact
   already-consumed one-time code from the successful pairing. Keep the code
   only in private operator memory while entering it; do not expose or log the
   code. The `/api/extension/pair` request must be rejected with `401`, no new
   installation may be created, and the popup must report that the pairing code
   was not accepted.
5. Confirm cleanup targets only the unique smoke row and unique smoke
   installation: delete the row, leave the exact installation revoked, and
   discard the transient code. Do not disconnect or revoke any unrelated
   installation or delete any unrelated application row.

Cleanup is unconditional, including when an earlier step fails: delete the
unique-marker row, disconnect the extension, remove the exact site permission,
and clear any stored installation credential from the dedicated profile. Do not
close the release until row cleanup, permission cleanup, and credential cleanup
are each confirmed. Record only pass/fail status, release identity, extension
ID, and timestamps; do not record the administrator token, pairing code,
installation credential, row, or resume.
