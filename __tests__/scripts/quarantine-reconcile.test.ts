import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createQuarantineFixture,
  invokeQuarantineWorker,
  prepareQuarantinedFixture,
  spawnLifecycleChild,
} from "../fixtures/quarantine/quarantine-test-harness";

const reconcileUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-reconcile.mjs")).href;
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function reconcile(options: Record<string, unknown>) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import * as api from ${JSON.stringify(reconcileUrl)};
    try {
      const result = await api.reconcileQuarantine(${JSON.stringify(options)});
      process.stdout.write(JSON.stringify({ ok: true, keys: Object.keys(api), result, frozen: Object.isFrozen(result) }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    }
  `], { encoding: "utf8" }));
}

function convertPreparedRunToV1(prepared: ReturnType<typeof prepareQuarantinedFixture>) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { readFileSync, readdirSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { appendJournalRecord, withJournalLock } from ${JSON.stringify(new URL("../../scripts/quarantine-journal.mjs", pathToFileURL(__filename)).href)};
    import { buildValidatedManifest, writeManifestGeneration } from ${JSON.stringify(new URL("../../scripts/quarantine-manifest.mjs", pathToFileURL(__filename)).href)};
    import { withQuarantineRunCapability } from ${JSON.stringify(new URL("../../scripts/quarantine-run-capability.mjs", pathToFileURL(__filename)).href)};
    const options = ${JSON.stringify({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })};
    const runRoot = ${JSON.stringify(prepared.runRoot)};
    const current = readdirSync(join(runRoot, "manifests")).find((name) => name.endsWith(".json"));
    const v2 = JSON.parse(readFileSync(join(runRoot, "manifests", current), "utf8"));
    const v1 = buildValidatedManifest({
      schemaVersion: 1, transactionId: v2.transactionId, state: "PREPARED",
      repositoryRoot: v2.repositoryRoot, head: v2.head, createdAt: v2.createdAt,
      validatedAt: null, retentionDays: 4, deletionRequiresConfirmation: true,
      deleteAfter: null, deletionStatus: "retained", entries: v2.entries,
    });
    rmSync(join(runRoot, "journal.log"));
    await withQuarantineRunCapability(options, async (capability) => {
      const generation = await writeManifestGeneration({ capability, manifest: v1 });
      await withJournalLock({ capability }, async (heldLock) => {
        const append = (event, payload) => appendJournalRecord({ capability, heldLock, event, payload, schemaVersion: 1 });
        await append("PREPARED", { transactionId: options.transactionId, manifestSha256: generation.manifestSha256 });
        await append("MOVING", {});
        for (const entry of v1.entries) {
          await append("MOVE_INTENT", { id: entry.id, expected: entry.preMoveInventory });
          await append("MOVED", { id: entry.id, observed: entry.preMoveInventory });
        }
        await append("VERIFYING", {});
        await append("QUARANTINED", {});
      });
    });
  `]);
}

function omitLastEntryFromSettledJournal(
  prepared: ReturnType<typeof prepareQuarantinedFixture>,
) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { readFileSync, readdirSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { appendJournalRecord, withJournalLock } from ${JSON.stringify(new URL("../../scripts/quarantine-journal.mjs", pathToFileURL(__filename)).href)};
    import { withQuarantineRunCapability } from ${JSON.stringify(new URL("../../scripts/quarantine-run-capability.mjs", pathToFileURL(__filename)).href)};
    const options = ${JSON.stringify({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })};
    const runRoot = ${JSON.stringify(prepared.runRoot)};
    const generation = readdirSync(join(runRoot, "manifests")).find((name) => name.endsWith(".json"));
    const manifest = JSON.parse(readFileSync(join(runRoot, "manifests", generation), "utf8"));
    const digest = generation.slice(0, -".json".length);
    rmSync(join(runRoot, "journal.log"));
    await withQuarantineRunCapability(options, async (capability) => {
      await withJournalLock({ capability }, async (heldLock) => {
        const append = (event, payload) => appendJournalRecord({
          capability, heldLock, event, payload, schemaVersion: 2,
        });
        await append("PREPARED", { transactionId: options.transactionId, manifestSha256: digest });
        await append("MOVING", {});
        for (const entry of manifest.entries.slice(0, -1)) {
          await append("MOVE_INTENT", { id: entry.id, expected: entry.preMoveInventory });
          await append("MOVED", { id: entry.id, observed: entry.preMoveInventory });
        }
        await append("VERIFYING", {});
        await append("QUARANTINED", {});
      });
    });
  `]);
}

describe("read-only quarantine reconciliation", () => {
  it("exports one separate authority and maps a complete QUARANTINED snapshot", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);

    const outcome = reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    });

    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome).toMatchObject({ ok: true, keys: ["reconcileQuarantine"], frozen: true });
    expect(outcome.result).toEqual({
      schemaVersion: 1,
      state: "QUARANTINED",
      complete: false,
      nextAction: "mark_validated",
    });
  });

  it("requires an exact writers-stopped option contract", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    const valid = {
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    };

    expect(reconcile({ ...valid, writersStopped: false })).toMatchObject({ ok: false, code: "ERR_USAGE" });
    expect(reconcile({ ...valid, surprise: true })).toMatchObject({ ok: false, code: "ERR_USAGE" });
  });

  it("fails closed on torn journal evidence without mutating it", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    const journal = join(prepared.runRoot, "journal.log");
    writeFileSync(journal, Buffer.concat([readFileSync(journal), Buffer.from([0, 0, 0])]));
    const before = readFileSync(journal);

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({ ok: false, code: "ERR_INTEGRITY" });
    expect(readFileSync(journal)).toEqual(before);
  });

  it("fails closed when selected manifest evidence is missing", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    const manifests = join(prepared.runRoot, "manifests");
    const generation = readdirSync(manifests).find((name) => name.endsWith(".json"));
    expect(generation).toBeDefined();
    rmSync(join(manifests, generation!));

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({ ok: false, code: "ERR_INTEGRITY" });
  });

  it("preserves v1 durable evidence while using reconciliation output version 1", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    convertPreparedRunToV1(prepared);

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state: "QUARANTINED", complete: false, nextAction: "mark_validated" },
    });
  });

  it("does not reclaim or rewrite an observed journal lock", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    const lock = join(prepared.runRoot, "journal.lock");
    const bytes = Buffer.from("operator-observed-lock\n");
    writeFileSync(lock, bytes, { mode: 0o600 });
    const journal = readFileSync(join(prepared.runRoot, "journal.log"));

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({ ok: true });
    expect(readFileSync(lock)).toEqual(bytes);
    expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(journal);
  });

  it.each([
    ["after-event:PREPARED", "PREPARED"],
    ["after-event:MOVING", "MOVING"],
    ["after-event:VERIFYING", "VERIFYING"],
  ] as const)("maps the apply state at %s without recovering it", (stopPhase, state) => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const transactionId = `reconcile-${state.toLowerCase()}`;
    const stopped = invokeQuarantineWorker("apply-stop", {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
      expectedCount: fixture.expectedCount,
      transactionId,
      createdAt: "2026-08-13T00:00:00.000Z",
      writersStopped: true,
      stopPhase,
    });
    expect(stopped.ok).toBe(false);

    expect(reconcile({
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      transactionId,
      writersStopped: true,
    })).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state, complete: false, nextAction: "recover_required" },
    });
  });

  it.each([
    ["after-event:RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["after-event:RESTORING", "RESTORING"],
  ] as const)("maps the restore state at %s without recovering it", (stopPhase, state) => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const stopped = invokeQuarantineWorker("restore", {
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
      stopPhase,
    });
    expect(stopped.ok).toBe(false);

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state, complete: false, nextAction: "recover_required" },
    });
  });

  it("maps VALIDATED retention and terminal RESTORED", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("mark-validated", {
      ...options, validatedAt: "2026-08-13T00:00:00.000Z",
    }).ok).toBe(true);
    const validated = reconcile(options);
    if (!validated.ok) throw new Error(JSON.stringify(validated));
    expect(validated).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state: "VALIDATED", complete: false, nextAction: "retain_and_review" },
    });

    expect(invokeQuarantineWorker("restore", options).ok).toBe(true);
    expect(reconcile(options)).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state: "RESTORED", complete: true, nextAction: "none" },
    });
  });

  it("maps terminal apply rollback", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const transactionId = "reconcile-rolled-back";
    const apply = {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
      expectedCount: fixture.expectedCount,
      transactionId,
      createdAt: "2026-08-13T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply-stop", {
      ...apply, stopPhase: "after-event:MOVING",
    }).ok).toBe(false);
    expect(invokeQuarantineWorker("recover", {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      transactionId,
      writersStopped: true,
      action: "rollback",
    }).result).toMatchObject({ status: "ROLLED_BACK" });
    expect(reconcile({
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      transactionId,
      writersStopped: true,
    })).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state: "ROLLED_BACK", complete: true, nextAction: "none" },
    });
  });

  it("fails closed when physical payload evidence conflicts with a settled journal", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    writeFileSync(join(prepared.runRoot, "payload/source-copies/copy-0001"), "tampered\n");

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({ ok: false, code: "ERR_INTEGRITY" });
  });

  it.each(["pre", "moved-pass-2"] as const)(
    "fails closed when a settled %s inventory is missing",
    (phase) => {
      const prepared = prepareQuarantinedFixture({ regenerate: false });
      bases.push(prepared.fixture.base);
      rmSync(join(prepared.runRoot, "inventories", phase, "copy-0001.jsonl"));

      expect(reconcile({
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      })).toMatchObject({ ok: false, code: "ERR_INTEGRITY" });
    },
  );

  it("explicitly requires settled apply intents and completions to cover the manifest", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);
    omitLastEntryFromSettledJournal(prepared);

    expect(reconcile({
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    })).toMatchObject({
      ok: false,
      code: "ERR_INTEGRITY",
      message: "settled apply journal does not cover the manifest",
    });
  });

  it.each([
    ["resume", "after-event:RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["rollback", "after-event:ROLLING_BACK", "ROLLING_BACK"],
  ] as const)("maps interrupted apply %s state %s", async (action, killAt, state) => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const transactionId = `reconcile-${state.toLowerCase()}`;
    const apply = {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
      expectedCount: fixture.expectedCount,
      transactionId,
      createdAt: "2026-08-13T00:00:00.000Z",
      writersStopped: true,
    };
    expect((await spawnLifecycleChild("quarantineWorkspace", apply, {
      killAt: "after-event:MOVE_INTENT:generated-next",
    })).signal).toBe("SIGKILL");
    rmSync(join(fixture.quarantineRoot, transactionId, "journal.lock"), { force: true });
    expect((await spawnLifecycleChild("recoverQuarantine", {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      transactionId,
      writersStopped: true,
      action,
    }, { killAt })).signal).toBe("SIGKILL");

    expect(reconcile({
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      transactionId,
      writersStopped: true,
    })).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state, complete: false, nextAction: "recover_required" },
    });
  });

  it.each([
    ["resume", "after-event:RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["rollback", "after-event:RESTORE_ROLLING_BACK", "RESTORE_ROLLING_BACK"],
  ] as const)("maps interrupted restore %s state %s", async (action, killAt, state) => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_INTENT:generated-next",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));
    expect((await spawnLifecycleChild("recoverRestore", { ...options, action }, {
      killAt,
    })).signal).toBe("SIGKILL");

    expect(reconcile(options)).toMatchObject({
      ok: true,
      result: { schemaVersion: 1, state, complete: false, nextAction: "recover_required" },
    });
  });

  it("maps a journal-authenticated restore conflict without hiding it as success", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_INTENT:copy-0001",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));
    writeFileSync(
      join(prepared.fixture.repoRoot, "notes 2.txt"),
      "foreign operator content\n",
    );
    expect((await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" }, {
      killAt: "after-event:INCOMPLETE_CONFLICT",
    })).signal).toBe("SIGKILL");

    expect(reconcile(options)).toMatchObject({
      ok: true,
      result: {
        schemaVersion: 1,
        state: "INCOMPLETE_CONFLICT",
        complete: false,
        nextAction: "investigate_conflict",
      },
    });
  });

  it.each(["missing", "corrupt"] as const)(
    "fails closed when a conflict entry's protected payload is %s",
    async (damage) => {
      const prepared = prepareQuarantinedFixture();
      bases.push(prepared.fixture.base);
      const options = {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:copy-0001",
      })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      writeFileSync(
        join(prepared.fixture.repoRoot, "notes 2.txt"),
        "foreign operator content\n",
      );
      expect((await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" }, {
        killAt: "after-event:INCOMPLETE_CONFLICT",
      })).signal).toBe("SIGKILL");
      const payload = join(
        prepared.runRoot,
        "payload/source-copies/copy-0001",
      );
      if (damage === "missing") rmSync(payload);
      else writeFileSync(payload, "corrupt protected payload\n");

      expect(reconcile(options)).toMatchObject({
        ok: false,
        code: "ERR_INTEGRITY",
      });
    },
  );

  it.each(["missing", "corrupt"] as const)(
    "fails closed when an active-tree conflict's protected rollback is %s",
    async (damage) => {
      const prepared = prepareQuarantinedFixture();
      bases.push(prepared.fixture.base);
      const options = {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORED_ENTRY:generated-next",
      })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      writeFileSync(
        join(prepared.fixture.repoRoot, ".next", "foreign"),
        "foreign active content\n",
      );
      expect((await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" }, {
        killAt: "after-event:INCOMPLETE_CONFLICT",
      })).signal).toBe("SIGKILL");
      const rollback = join(
        prepared.runRoot,
        "rollback/regenerated-before-restore",
        "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
        ".next",
      );
      if (damage === "missing") rmSync(rollback, { recursive: true });
      else writeFileSync(join(rollback, "foreign"), "corrupt protected rollback\n");

      expect(reconcile(options)).toMatchObject({
        ok: false,
        code: "ERR_INTEGRITY",
      });
    },
  );

  it("fails closed when a restore conflict coexists with unrelated missing evidence", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot,
      quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId,
      writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_INTENT:copy-0001",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));
    writeFileSync(join(prepared.fixture.repoRoot, "notes 2.txt"), "canonical\n");
    expect((await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" }, {
      killAt: "after-event:INCOMPLETE_CONFLICT",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.fixture.repoRoot, ".next"), { recursive: true, force: true });

    expect(reconcile(options)).toMatchObject({ ok: false, code: "ERR_INTEGRITY" });
  });
});
