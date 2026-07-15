# Chrome Smoke Follow-up Design

## Context

The production system-Chrome smoke passed end to end: the unpacked extension
paired with the canonical production origin, extracted and saved a real Lever
posting, restored the connection after reopening, deleted the temporary row,
returned the dashboard total to 153, and removed credentials and host access on
disconnect.

The smoke exposed three narrow follow-up issues:

1. The popup renders an em dash as mojibake because its HTML does not declare a
   character encoding.
2. The Lever extractor saved `Olo logo` instead of `Olo` because it accepted a
   presentation-oriented metadata or image label as the company name.
3. The operations runbook does not describe current Chrome 150 UI semantics:
   the token input is intentionally empty after pairing, and a previously
   requested origin can remain listed after removal while its toggle is off.

## Scope

### Popup encoding

Add `<meta charset="UTF-8">` as the first element inside `extension/popup.html`
`<head>`. Do not change popup copy or styling. Existing em dashes must render as
Unicode characters after the unpacked extension is reloaded.

### Lever company normalization

Normalize only the selected Lever company label. Remove a case-insensitive,
standalone trailing `logo` token plus surrounding whitespace when the remaining
text is non-empty.

Examples:

- `Olo logo` becomes `Olo`.
- `Acme LOGO` becomes `Acme`.
- `Logo Design Inc.` remains unchanged.
- `Logo` remains unchanged because normalization must not produce an empty
  company name.

Apply the helper after the existing source preference (`og:site_name`, then
logo-image `alt`). Do not add broader `icon` or `brand` removal, URL-slug
fallbacks, network requests, or changes to other job-board extractors.

### Chrome smoke runbook

Update `docs/operations/chrome-extension-smoke.md` to state:

- Successful pairing clears the visible token input by design; connection
  status and reopen restoration are the relevant checks.
- After disconnect, reload must remain disconnected to confirm no stored
  credential is restored.
- Current Chrome may keep an exact runtime-requested origin in the Site access
  list after permission removal. The origin's toggle must be off; mere list
  presence is not evidence that permission remains granted.
- Any cleanup warning in the popup is a failure and must be resolved before
  release closure.

Do not weaken the existing requirement to delete the temporary row, disconnect,
and remove the exact host permission.

## Testing

Follow test-driven development:

1. Add focused content-extractor cases for trailing `logo`, uppercase `LOGO`, a
   legitimate internal `Logo`, and the all-`Logo` fallback; verify the new cases
   fail before implementation.
2. Add `__tests__/extension/popup-html.test.ts`, a static popup contract test
   that asserts the charset declaration is the first `<head>` child; verify it
   fails before changing the HTML.
3. Implement only the charset declaration and narrow Lever normalization.
4. Run the focused extension suites, extension syntax/manifest check, full Jest
   suite, lint, and isolated extension E2E journey.
5. Reload the unpacked extension in system Chrome and confirm the em dash and
   `Olo` extraction, without saving another production row unless the existing
   automated checks reveal a need for a full destructive smoke.

## Delivery

Implement on `codex/chrome-smoke-followup`, request independent spec and code
quality reviews, push a pull request, wait for required checks, and merge into
`main`. Preserve the pre-existing untracked numbered duplicate files.

## Success criteria

- Popup status text renders `—`, never `â€”`.
- The reviewed Olo Lever posting extracts company `Olo`.
- Legitimate company labels containing `Logo` are not over-normalized.
- Runbook cleanup guidance matches observed Chrome 150 behavior.
- All focused, full, and extension E2E checks pass.
