import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  invokeQuarantineWorker,
  git,
  prepareQuarantinedFixture,
  type ValueShape,
} from "../fixtures/quarantine/quarantine-test-harness";

const coreUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-lifecycle-core.mjs"),
).href;
const internalUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-lifecycle-internal.mjs")).href;
const restorePath = join(__dirname, "../../scripts/quarantine-restore.mjs");

describe("quarantine lifecycle core", () => {
  it("keeps its single private entry point closed", async () => {
    const core = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const core = await import(${JSON.stringify(coreUrl)});
      process.stdout.write(JSON.stringify({ keys: Object.keys(core), arity: core.withExistingQuarantineRun.length }));
    `], { encoding: "utf8" }));

    expect(core).toEqual({ keys: ["withExistingQuarantineRun"], arity: 2 });
    const publicExports = invokeQuarantineWorker("exports", {});
    expect(publicExports.exports).not.toContain("withExistingQuarantineRun");
    expect(publicExports.runtimeExports).not.toContain("withExistingQuarantineRun");
    expect(publicExports.legacyExports).not.toContain("withExistingQuarantineRun");
    expect(publicExports.exports).not.toContain("summarizeInventoryDirectory");
    expect(publicExports.runtimeExports).not.toContain("summarizeInventoryDirectory");
    expect(publicExports.legacyExports).not.toContain("summarizeInventoryDirectory");
  });

  it("keeps direct lifecycle imports from bypassing the sole core setup", () => {
    const direct = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const internal = await import(${JSON.stringify(internalUrl)});
      let called = false;
      let error = null;
      try {
        await internal.withExistingQuarantineRunInternal({
          repoRoot: "/not-a-repo", quarantineRoot: "/not-a-quarantine",
          transactionId: "test", writersStopped: true, action: "resume",
        }, async () => { called = true; });
      } catch (caught) { error = caught.message; }
      process.stdout.write(JSON.stringify({
        keys: Object.keys(internal), genericArity: internal.withExistingQuarantineRunInternal.length,
        recoveryEntry: internal.withRestoreRecoveryRunInternal ?? null,
        recoveryHandoff: internal.takeRestoreRecoveryHandoff ?? null,
        called, error,
      }));
    `], { encoding: "utf8" }));
    expect(direct).toEqual({
      keys: ["withExistingQuarantineRunInternal"], genericArity: 2,
      recoveryEntry: null, recoveryHandoff: null,
      called: false, error: "existing quarantine run options are invalid",
    });
    expect(readFileSync(restorePath, "utf8")).not.toContain("quarantine-lifecycle-internal.mjs");
  });

  it("publishes one immutable VALIDATED generation and reuses it on retry", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const request = {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        validatedAt: "2026-08-11T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invokeQuarantineWorker("mark-validated", request);
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      expect(first).toMatchObject({
        ok: true,
        result: {
          transactionId: prepared.transactionId,
          status: "VALIDATED",
          validatedAt: request.validatedAt,
          deleteAfter: "2026-08-15T00:00:00.000Z",
          deletionRequiresConfirmation: true,
        },
      });
      expect(first.phases).toEqual([
        "after-inventory:validation-pass-1:generated-next",
        "after-inventory:validation-pass-2:generated-next",
        "after-inventory:validation-pass-1:generated-node-modules",
        "after-inventory:validation-pass-2:generated-node-modules",
        "after-validated-generation",
        "after-event:VALIDATED",
        "before-lock-cleanup",
        "after-pointer-temporary-sync",
        "after-pointer-rename",
        "after-pointer-root-sync",
      ]);
      const retry = invokeQuarantineWorker("mark-validated", {
        ...request,
        validatedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(retry).toMatchObject({ ok: true, result: first.result });
      expect(retry.phases).toEqual([
        "after-pointer-temporary-sync",
        "after-pointer-rename",
        "after-pointer-root-sync",
      ]);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    "after-inventory:validation-pass-1:generated-next",
    "after-inventory:validation-pass-2:generated-next",
    "after-inventory:validation-pass-1:generated-node-modules",
    "after-inventory:validation-pass-2:generated-node-modules",
    "after-validated-generation",
    "after-event:VALIDATED",
    "before-lock-cleanup",
    "after-pointer-temporary-sync",
    "after-pointer-rename",
    "after-pointer-root-sync",
  ])("propagates interruption at validation public phase %s without deleting evidence", (stopPhase) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const journal = join(prepared.runRoot, "journal.log");
      const beforeJournal = readFileSync(journal);
      const result = invokeQuarantineWorker("mark-validated", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        validatedAt: "2026-08-11T00:00:00.000Z",
        writersStopped: true,
        stopPhase,
      }) as unknown as { ok: boolean; phases: string[] };
      expect(result.ok).toBe(false);
      expect(result.phases).toContain(stopPhase);
      expect(readFileSync(journal).subarray(0, beforeJournal.length)).toEqual(beforeJournal);
      expect(existsSync(prepared.runRoot)).toBe(true);
      expect(existsSync(join(prepared.fixture.quarantineRoot, prepared.transactionId))).toBe(true);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("hands only frozen, null-prototype lifecycle evidence to the callback", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as { callbackInvoked: number; observed: Record<string, ValueShape> };
      expect(result.callbackInvoked).toBe(1);
      expect(result.observed.handoff).toMatchObject({
        prototype: "null",
        frozen: true,
        keys: [
          "capability", "repoRoot", "quarantineRoot", "runRoot", "transactionId", "head",
          "journalTip", "manifestGeneration", "fsApi",
        ],
      });
      expect(result.observed.journalTip).toMatchObject({
        prototype: "null",
        frozen: true,
        keys: ["sequence", "recordHash", "event", "state", "payload"],
      });
      expect(result.observed.manifestGeneration).toMatchObject({
        prototype: "null",
        frozen: true,
        keys: ["manifestSha256", "state", "manifest"],
      });
      expect(result.observed.fsApi).toMatchObject({ prototype: "null", frozen: true });
      for (const shape of [
        result.observed.handoff,
        result.observed.journalTip,
        result.observed.manifestGeneration,
      ]) {
        for (const descriptor of Object.values(shape.descriptors)) {
          expect(descriptor).toEqual(expect.objectContaining({
            enumerable: true,
            configurable: false,
            writable: false,
          }));
        }
      }
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("captures every supplied filesystem method once before awaiting and revokes it", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        fsCapture: true,
      }) as unknown as {
        getters: Record<string, number>;
        wrongReceiver: number;
        revoked: boolean;
      };
      expect(Object.values(result.getters)).toHaveLength(14);
      expect(Object.values(result.getters)).toEqual(Array(14).fill(1));
      expect(result.wrongReceiver).toBe(0);
      expect(result.revoked).toBe(true);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("uses the omitted default filesystem source only through a frozen revocable handoff", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as {
        ok: boolean; callbackInvoked: number; revoked: boolean;
        observed: { fsApi: { frozen: boolean; prototype: string; descriptors: Record<string, { writable: boolean; configurable: boolean }> } };
      };
      expect(result).toMatchObject({ ok: true, callbackInvoked: 1, revoked: true });
      expect(result.observed.fsApi).toMatchObject({ frozen: true, prototype: "null" });
      for (const descriptor of Object.values(result.observed.fsApi.descriptors)) {
        expect(descriptor).toMatchObject({ writable: false, configurable: false, callable: true });
      }
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    "malformed-json",
    "foreign-transaction",
    "foreign-digest",
    "path-bearing",
    "symlink",
  ])("rejects a %s current pointer before callback and preserves its evidence", (variant) => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const pointer = join(prepared.fixture.quarantineRoot, "current");
      if (variant === "malformed-json") writeFileSync(pointer, "{");
      else if (variant === "foreign-transaction") writeFileSync(pointer, JSON.stringify({
        schemaVersion: 1, transactionId: "foreign", manifestSha256: "a".repeat(64),
      }));
      else if (variant === "foreign-digest") writeFileSync(pointer, JSON.stringify({
        schemaVersion: 1, transactionId: prepared.transactionId, manifestSha256: "a".repeat(64),
      }));
      else if (variant === "path-bearing") writeFileSync(pointer, JSON.stringify({
        schemaVersion: 1, transactionId: prepared.transactionId, manifestSha256: "a".repeat(64), path: "/foreign",
      }));
      else {
        writeFileSync(join(prepared.fixture.quarantineRoot, "pointer-sentinel"), "foreign");
        symlinkSync(join(prepared.fixture.quarantineRoot, "pointer-sentinel"), pointer);
      }
      const before = readFileSync(pointer);
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as { ok: boolean; callbackInvoked: number };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0 });
      expect(readFileSync(pointer)).toEqual(before);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each(["missing", "corrupt"]) ("rejects a %s prepared manifest generation before callback", (variant) => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const manifests = join(prepared.runRoot, "manifests");
      const generation = join(manifests, readdirSync(manifests)[0]);
      const beforeJournal = readFileSync(join(prepared.runRoot, "journal.log"));
      if (variant === "missing") rmSync(generation);
      else writeFileSync(generation, "{\"foreign\":true}\n");
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as { ok: boolean; callbackInvoked: number };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0 });
      expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(beforeJournal);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a replacement quarantine/run identity before invoking the callback", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        staleIdentity: true,
      }) as unknown as { ok: boolean; callbackInvoked: number; staleIdentity: boolean };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0, staleIdentity: true });
      expect(existsSync(join(prepared.fixture.quarantineRoot, "replacement-sentinel"))).toBe(true);
      expect(readFileSync(join(prepared.fixture.quarantineRoot, "replacement-sentinel"), "utf8")).toBe("foreign");
      expect(existsSync(join(prepared.fixture.quarantineRoot + ".original", prepared.transactionId, "journal.log"))).toBe(true);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("revokes its filesystem handoff when the callback throws", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        callbackThrows: true,
      }) as unknown as { ok: boolean; callbackInvoked: number; revoked: boolean };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 1, revoked: true });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each(["source-residue", "missing-generated-root", "path-bearing-pointer"])(
    "rejects %s without changing durable evidence",
    (kind) => {
      const prepared = prepareQuarantinedFixture();
      try {
        const journal = join(prepared.runRoot, "journal.log");
        const pointer = join(prepared.fixture.quarantineRoot, "current");
        const beforeJournal = readFileSync(journal);
        if (kind === "source-residue") {
          writeFileSync(join(prepared.fixture.repoRoot, "notes 2.txt"), "residue\n");
        } else if (kind === "missing-generated-root") {
          rmSync(join(prepared.fixture.repoRoot, ".next"), { recursive: true });
        } else {
          writeFileSync(pointer, JSON.stringify({
            schemaVersion: 1,
            transactionId: prepared.transactionId,
            manifestSha256: "a".repeat(64),
            path: "/foreign",
          }));
        }
        const result = invokeQuarantineWorker("mark-validated", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          validatedAt: "2026-08-11T00:00:00.000Z",
          writersStopped: true,
        });
        expect(result.ok).toBe(false);
        expect(readFileSync(journal)).toEqual(beforeJournal);
        if (kind === "path-bearing-pointer") {
          expect(readFileSync(pointer, "utf8")).toContain("/foreign");
        }
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    },
  );

  it("rejects a pre-existing journal lock before validation writes any generation", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const manifests = join(prepared.runRoot, "manifests");
      const before = readFileSync(join(prepared.runRoot, "journal.log"));
      writeFileSync(join(prepared.runRoot, "journal.lock"), "foreign lock", { mode: 0o600 });
      const result = invokeQuarantineWorker("mark-validated", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        validatedAt: "2026-08-11T00:00:00.000Z",
        writersStopped: true,
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(before);
      expect(readdirSync(manifests)).toHaveLength(1);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a torn journal without invoking the lifecycle callback", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      appendFileSync(join(prepared.runRoot, "journal.log"), Buffer.from([0, 0, 0]));
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as { ok: boolean; callbackInvoked: number };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0 });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a clean repository whose HEAD no longer matches the quarantine evidence", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      writeFileSync(join(prepared.fixture.repoRoot, "notes.txt"), "new head\n");
      git(prepared.fixture.repoRoot, "add", "notes.txt");
      git(prepared.fixture.repoRoot, "commit", "-m", "different head");
      const journal = readFileSync(join(prepared.runRoot, "journal.log"));
      const result = invokeQuarantineWorker("mark-validated", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        validatedAt: "2026-08-11T00:00:00.000Z",
        writersStopped: true,
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(journal);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a nested Git working directory instead of treating it as the repository root", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: join(prepared.fixture.repoRoot, ".next"),
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as { ok: boolean; callbackInvoked: number };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0 });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects journal evidence changed between initial validation and callback handoff", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        mutateJournalBeforeCallback: true,
      }) as unknown as { ok: boolean; callbackInvoked: number };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0 });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each(["repo-swap", "head-advance"]) (
    "rejects callback-boundary %s evidence drift without invoking the callback",
    (callbackBoundary) => {
      const prepared = prepareQuarantinedFixture({ regenerate: false });
      try {
        const before = readFileSync(join(prepared.runRoot, "journal.log"));
        const result = invokeQuarantineWorker("core-contract", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          callbackBoundary,
        }) as unknown as {
          ok: boolean;
          callbackInvoked: number;
          boundarySentinel?: boolean;
          durableEvidenceStable?: boolean;
          callbackBoundary?: { firedAt: number; firstPassCompleted: boolean };
        };
        expect(result).toMatchObject({ ok: false, callbackInvoked: 0 });
        expect(result.callbackBoundary).toEqual({ firedAt: 4, firstPassCompleted: true });
        expect(result.durableEvidenceStable).toBe(true);
        if (callbackBoundary === "repo-swap") expect(result.boundarySentinel).toBe(true);
        expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(before);
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
  );

  it.each([
    ["QUARANTINED", false], ["VALIDATED", true],
  ] as const)("accepts %s provenance across each durable restore context", (preState, regenerate) => {
    for (const restoreState of ["RESTORE_PREPARED", "RESTORING", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK"]) {
      const prepared = prepareQuarantinedFixture({ regenerate });
      try {
        const result = invokeQuarantineWorker("core-restore-contract", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          restoreState,
          preState,
        }) as unknown as { ok: boolean; callbackInvoked: number };
        expect(result).toEqual({ ok: true, callbackInvoked: 1 });
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    }
  });

  it("rejects a restore payload whose inventory differs from the durable manifest", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      writeFileSync(join(prepared.runRoot, "payload/generated/.next/build"), "foreign");
      const result = invokeQuarantineWorker("core-restore-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        restoreState: "RESTORE_PREPARED",
      }) as unknown as { ok: boolean };
      expect(result.ok).toBe(false);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each(["QUARANTINED", "VALIDATED"] as const)(
    "accepts a restore tree with canonical inner symlinks from %s provenance without following them",
    (preState) => {
      const prepared = prepareQuarantinedFixture({
        regenerate: preState === "VALIDATED",
        generatedInnerSymlink: true,
      });
      try {
        const result = invokeQuarantineWorker("core-restore-matrix", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          row: "intent-pre",
          preState,
        }, {}, 30_000) as unknown as { ok: boolean; callbackInvoked: number; externalReads?: number };
        expect(result).toMatchObject({ ok: true, callbackInvoked: 1, externalReads: 0 });
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
  );

  it("accepts the durable pre-rename row after a forward restore intent", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-restore-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        restoreState: "RESTORING",
        restoreIntent: true,
      }) as unknown as { ok: boolean; callbackInvoked: number };
      expect(result).toEqual({ ok: true, callbackInvoked: 1 });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    "prepared",
    "intent-pre",
    "stage",
    "completed",
    "no-active-pre",
    "no-active-completed",
    "mixed-prefix",
    "rollback-pre",
    "rollback-post-first",
    "rollback-post-second",
    "rollback-partial-prefix",
    "source-pre",
    "source-mid",
    "source-post",
    "source-rollback-pre",
    "source-rollback-post",
  ])("accepts the real filesystem restore seam row %s from both Q and V provenance", (row) => {
    for (const preState of ["QUARANTINED", "VALIDATED"] as const) {
      const prepared = prepareQuarantinedFixture({ regenerate: preState === "VALIDATED" });
      try {
        const result = invokeQuarantineWorker("core-restore-matrix", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          row,
          preState,
        }, {}, 30_000) as unknown as { ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean; error?: unknown };
        expect(result).toEqual(expect.objectContaining({ ok: true, callbackInvoked: 1, durableStable: true, endpointsStable: true }));
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    }
  });

  it.each([
    ["extra payload after completion", "completed", "wrong-payload"],
    ["foreign active endpoint", "completed", "wrong-active"],
    ["extra rollback endpoint", "completed", "extra-rollback"],
    ["missing required rollback endpoint", "stage", "missing-rollback"],
    ["foreign required rollback endpoint", "stage", "wrong-rollback"],
    ["workspace endpoint symlink", "completed", "endpoint-symlink"],
    ["foreign restored source copy", "source-post", "wrong-source-active"],
  ])("rejects a restore seam with %s without mutating the journal or pointer", (_label, row, corruption) => {
    const prepared = prepareQuarantinedFixture({ regenerate: true });
    try {
      const result = invokeQuarantineWorker("core-restore-matrix", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        row,
        preState: "VALIDATED",
        corruption,
      }, {}, 30_000) as unknown as { ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean; evidenceStable: boolean };
      expect(result).toEqual(expect.objectContaining({ ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true, evidenceStable: true }));
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([1, 2])("rejects a deterministic workspace ancestor swap at validation pass %i", (ancestorSwap) => {
    const copyPath = "nested/notes 2.txt";
    const prepared = prepareQuarantinedFixture({ canonicalPath: "nested/notes.txt", copyPath });
    try {
      const result = invokeQuarantineWorker("core-restore-matrix", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        row: "source-pre",
        preState: "QUARANTINED",
        copyPath,
        ancestorSwap,
      }, {}, 30_000) as unknown as {
        ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean; externalReads: number; foreignIntact: boolean;
      };
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        callbackInvoked: 0,
        durableStable: true,
        endpointsStable: true,
        externalReads: 0,
        foreignIntact: true,
      }));
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each(["file", "directory"] as const)(
    "rejects a descendant %s swap after lstat without following the foreign target",
    (descendantSwap) => {
      const prepared = prepareQuarantinedFixture({ generatedNestedDirectory: descendantSwap === "directory" });
      try {
        const result = invokeQuarantineWorker("core-restore-matrix", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          row: "intent-pre",
          preState: "QUARANTINED",
          descendantSwap,
        }, {}, 30_000) as unknown as {
          ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean;
          evidenceStable: boolean; externalReads: number; foreignIntact: boolean;
        };
        expect(result).toEqual(expect.objectContaining({
          ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true,
          evidenceStable: true, externalReads: 0, foreignIntact: true,
        }));
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
  );

  it.each([
    "after-open-before-opendir",
    "after-opendir-before-check",
    "after-post-check",
  ])("rejects a generated directory swap at %s without reading the foreign Dir", (treeSwapPhase) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const result = invokeQuarantineWorker("core-restore-matrix", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        row: "intent-pre",
        preState: "QUARANTINED",
        treeSwapPhase,
      }, {}, 30_000) as unknown as {
        ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean;
        evidenceStable: boolean; externalReads: number; foreignIntact: boolean; externalDirReads: number; heldDirReads: number;
        verifiedDirectoryHandleCloses: number; heldDirStreamCloses: number;
      };
      expect(result).toEqual(expect.objectContaining({
        ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true,
        evidenceStable: true, externalReads: 0, externalDirReads: 0, foreignIntact: true,
        verifiedDirectoryHandleCloses: 1,
        heldDirStreamCloses: 1,
      }));
      expect(result.heldDirReads).toBe(treeSwapPhase === "after-post-check" ? 2 : 0);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  });

  it.each(["after-lstat-before-open", "after-open-before-read"])(
    "rejects a source file swap at %s without reading foreign bytes",
    (sourceSwapPhase) => {
      const prepared = prepareQuarantinedFixture();
      try {
        const result = invokeQuarantineWorker("core-restore-matrix", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          row: "source-pre",
          preState: "QUARANTINED",
          sourceSwapPhase,
        }, {}, 30_000) as unknown as {
          ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean;
          evidenceStable: boolean; externalReads: number; foreignIntact: boolean; externalFileReads: number;
          verifiedFileCloses: number;
        };
        expect(result).toEqual(expect.objectContaining({
          ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true,
          evidenceStable: true, externalReads: 0, externalFileReads: 0, foreignIntact: true,
          verifiedFileCloses: sourceSwapPhase === "after-lstat-before-open" ? 0 : 1,
        }));
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
  );

  it.each(["before-child-lstat", "after-child-open-before-read"])(
    "rejects a queued generated child when its closed parent is swapped at %s",
    (queuedAncestorSwapPhase) => {
      const prepared = prepareQuarantinedFixture({ generatedNestedDirectory: true });
      try {
        const result = invokeQuarantineWorker("core-restore-matrix", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          row: "intent-pre",
          preState: "QUARANTINED",
          queuedAncestorSwapPhase,
        }, {}, 30_000) as unknown as {
          ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean;
          evidenceStable: boolean; externalReads: number; externalFileReads: number; heldChildFileReads: number;
          foreignIntact: boolean; verifiedChildFileCloses: number;
        };
        expect(result).toEqual(expect.objectContaining({
          ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true,
          evidenceStable: true, externalReads: 0, externalFileReads: 0, heldChildFileReads: 0,
          foreignIntact: true,
          verifiedChildFileCloses: queuedAncestorSwapPhase === "before-child-lstat" ? 0 : 1,
        }));
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
  );

  it.each(["before-source-open", "after-source-open-before-read"])(
    "rejects a nested source copy ancestor swap at %s before source bytes are read",
    (sourceAncestorSwapPhase) => {
      const copyPath = "nested/notes 2.txt";
      const prepared = prepareQuarantinedFixture({ canonicalPath: "nested/notes.txt", copyPath });
      try {
        const result = invokeQuarantineWorker("core-restore-matrix", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          row: "source-post",
          preState: "QUARANTINED",
          copyPath,
          sourceAncestorSwapPhase,
        }, {}, 30_000) as unknown as {
          ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean;
          evidenceStable: boolean; externalReads: number; externalFileReads: number; heldSourceFileReads: number;
          foreignIntact: boolean; verifiedFileCloses: number;
        };
        expect(result).toEqual(expect.objectContaining({
          ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true,
          evidenceStable: true, externalReads: 0, externalFileReads: 0, heldSourceFileReads: 0,
          foreignIntact: true,
          verifiedFileCloses: sourceAncestorSwapPhase === "before-source-open" ? 0 : 1,
        }));
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
  );

  it.each(["source-pre", "source-rollback-pre"]) (
    "derives the Q/V source restore prefix from a durable copy-before-generated manifest for %s",
    (row) => {
      const copyPath = ".alpha 2.txt";
      for (const preState of ["QUARANTINED", "VALIDATED"] as const) {
        const prepared = prepareQuarantinedFixture({ canonicalPath: ".alpha.txt", copyPath, regenerate: preState === "VALIDATED" });
        try {
          const result = invokeQuarantineWorker("core-restore-matrix", {
            repoRoot: prepared.fixture.repoRoot,
            quarantineRoot: prepared.fixture.quarantineRoot,
            transactionId: prepared.transactionId,
            row,
            preState,
            copyPath,
          }, {}, 30_000) as unknown as { ok: boolean; callbackInvoked: number };
          expect(result).toMatchObject({ ok: true, callbackInvoked: 1 });
        } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
      }
    },
  );

  it("rejects a forged generated-first source intent when the durable manifest orders the copy first", () => {
    const copyPath = ".alpha 2.txt";
    const prepared = prepareQuarantinedFixture({ canonicalPath: ".alpha.txt", copyPath });
    try {
      const result = invokeQuarantineWorker("core-restore-matrix", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        row: "source-pre",
        preState: "QUARANTINED",
        copyPath,
        corruption: "out-of-order-intent",
      }, {}, 30_000) as unknown as { ok: boolean; callbackInvoked: number; durableStable: boolean; endpointsStable: boolean; evidenceStable: boolean };
      expect(result).toMatchObject({ ok: false, callbackInvoked: 0, durableStable: true, endpointsStable: true, evidenceStable: true });
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  });
});
