# Quarantine Retention Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Locate the previously validated external quarantine evidence and confirm its retained, review-only state without deleting, moving, restoring, or rewriting anything.

**Architecture:** Discovery uses filesystem metadata only. The repository's canonical `reconcile` command then validates manifest, journal, payload, inventories, pointer, and repository identity under a stopped-writer attestation. All evidence remains outside Git.

**Tech Stack:** macOS filesystem tools, Node.js 22.22.2, `cleanup:quarantine` CLI, SHA-256 evidence.

---

### Task 1: Locate a single candidate without mutation

**Files:** None.

- [ ] **Step 1: Stop local repository writers**

Confirm no Jest, Next, Prisma, backup, quarantine, or build process has the repository as its working directory. Stop only task-owned processes; do not kill unrelated user processes. Do not run builds or edits until the review finishes.

- [ ] **Step 2: Discover pointer candidates**

Run a read-only search limited to the user's home and mounted volumes:

```bash
find /Users/taejunoh /Volumes \
  -type f \
  -path '*/manifests/current.json' \
  -path '*quarantine*' \
  -print 2>/dev/null
```

For each candidate, inspect only path, owner, mode, byte size, and parsed pointer keys. A valid pointer has exactly `schemaVersion`, `transactionId`, and `manifestSha256`. Do not open payload files.

- [ ] **Step 3: Bind the candidate to this repository**

Resolve the pointed immutable manifest using the repository's manifest layout and require its `repositoryRoot` to equal one of the two known historical roots:

```text
/Users/taejunoh/Developer/LFG/easy-job-application-tracker
/Users/taejunoh/Desktop/LFG/easy-job-application-tracker
```

Require one unambiguous candidate. If none or more than one passes, stop and report the candidate paths and evidence gap; do not guess.

### Task 2: Validate the retained lifecycle state

**Files:** None.

- [ ] **Step 1: Verify the current checkout is safe to use as the CLI runtime**

```bash
git status --short --branch
npm ci
npm run check:audit
```

Expected: clean tracked state and successful install/audit. `npm ci` may update only ignored `node_modules`; it must not touch the external quarantine root.

- [ ] **Step 2: Run canonical read-only reconciliation**

Set `REPO_ROOT` to the manifest-bound historical repository root, `QUARANTINE_ROOT` to the unique parent found in Task 1, and `TRANSACTION_ID` to the exact pointer value. Then run:

```bash
npm run cleanup:quarantine -- reconcile \
  --repo-root "$REPO_ROOT" \
  --quarantine-root "$QUARANTINE_ROOT" \
  --transaction-id "$TRANSACTION_ID" \
  --writers-stopped
```

Expected: exit zero, `status` is `VALIDATED`, mutation is false, and `nextAction` is `retain_and_review`. Capture stdout only as a sanitized operator result; it must contain no payload bytes.

- [ ] **Step 3: Confirm retention invariants from metadata**

Require:

- pointer digest equals the immutable manifest SHA-256;
- manifest transaction ID and repository root equal the selected values;
- manifest state is `VALIDATED`;
- `deleteAfter` equals exactly 96 hours after `validatedAt`;
- payload and inventory paths still exist with their recorded counts/digests;
- no active journal lock, partial generation, restore transaction, or conflict result;
- elapsed `deleteAfter` does not change `nextAction` from `retain_and_review`.

Use the CLI result and manifest metadata; do not enumerate or print private payload contents.

### Task 3: Record a non-destructive review result

**Files:** None in the repository.

- [ ] **Step 1: Produce a sanitized summary in the task response**

Report only: quarantine root path, transaction ID, manifest digest, lifecycle state, entry count, `validatedAt`, `deleteAfter`, reconciliation outcome, and confirmation that no mutation occurred. Do not include file contents or private payload paths below the quarantine root.

- [ ] **Step 2: Reconfirm no mutation**

Compare pointer/manifest/journal hashes and directory metadata captured before and after reconciliation. Require equality, except filesystem access timestamps if the volume records them. Run `git status --short --branch` and require no tracked or untracked repository changes from the review.

- [ ] **Step 3: Stop without deletion**

Do not invoke `apply`, `recover`, `mark-validated`, or `restore`. Do not use `rm`, `mv`, `git clean`, manual journal edits, or a newly invented deletion command. A future deletion requires a separate lifecycle design and explicit destructive approval naming the exact transaction.
