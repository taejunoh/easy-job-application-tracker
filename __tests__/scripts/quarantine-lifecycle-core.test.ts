import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  invokeQuarantineWorker,
  git,
  prepareQuarantinedFixture,
} from "../fixtures/quarantine/quarantine-test-harness";

const coreUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-lifecycle-core.mjs"),
).href;

describe("quarantine lifecycle core", () => {
  it("keeps its single private entry point closed", async () => {
    const core = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const core = await import(${JSON.stringify(coreUrl)});
      process.stdout.write(JSON.stringify(Object.keys(core)));
    `], { encoding: "utf8" }));

    expect(core).toEqual(["withExistingQuarantineRun"]);
    const publicExports = invokeQuarantineWorker("exports", {});
    expect(publicExports.exports).not.toContain("withExistingQuarantineRun");
    expect(publicExports.runtimeExports).not.toContain("withExistingQuarantineRun");
    expect(publicExports.legacyExports).not.toContain("withExistingQuarantineRun");
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

  it("hands only frozen, null-prototype lifecycle evidence to the callback", () => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const result = invokeQuarantineWorker("core-contract", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
      }) as unknown as { callbackInvoked: number; observed: Record<string, { keys: string[]; frozen: boolean; prototype: string }> };
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

  it.each(["RESTORE_PREPARED", "RESTORING", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK"])(
    "accepts durable QUARANTINED provenance through %s restore context",
    (restoreState) => {
      const prepared = prepareQuarantinedFixture({ regenerate: false });
      try {
        const result = invokeQuarantineWorker("core-restore-contract", {
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          restoreState,
        }) as unknown as { ok: boolean; callbackInvoked: number };
        expect(result).toEqual({ ok: true, callbackInvoked: 1 });
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    },
  );
});
