import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { prepareQuarantinedFixture, invokeQuarantineWorker } from "../fixtures/quarantine/quarantine-test-harness";

const restoreUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-restore.mjs"),
).href;

describe("quarantine restore", () => {
  it("exports only restoreQuarantine", () => {
    const exports = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const module = await import(${JSON.stringify(restoreUrl)});
      process.stdout.write(JSON.stringify(Object.keys(module)));
    `], { encoding: "utf8" }));
    expect(exports).toEqual(["restoreQuarantine"]);
  });

  it("restores the deterministic transaction namespace in manifest order", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({
        ok: true,
        result: {
          transactionId: "tx-0001",
          restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
          status: "RESTORED",
          restoredEntries: 3,
        },
      });
      expect(existsSync(prepared.fixture.copyPath!)).toBe(false);
      expect(readFileSync(`${prepared.fixture.repoRoot}/${prepared.fixture.copyPath}`, "utf8")).toBe("canonical\n");
      expect(result.phases).toEqual(expect.arrayContaining([
        "after-inventory:restore-active:generated-next",
        "after-inventory:restore-active:generated-node-modules",
        "after-event:RESTORE_PREPARED",
        "after-event:RESTORING",
        "after-event:RESTORED",
        "before-lock-cleanup",
      ]));
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    [true, true], [true, false], [false, true], [false, false],
  ])("records the exact active-generated presence matrix (%s, %s)", (nextPresent, modulesPresent) => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const roots: Array<[boolean, string, string]> = [
        [nextPresent, ".next", "build"], [modulesPresent, "node_modules", "package"],
      ];
      for (const [present, directory, file] of roots) {
        if (!present) continue;
        mkdirSync(join(prepared.fixture.repoRoot, directory), { recursive: true, mode: 0o700 });
        writeFileSync(join(prepared.fixture.repoRoot, directory, file), "regenerated\n");
      }
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const journal = readFileSync(join(prepared.runRoot, "journal.log"), "utf8");
      expect(journal).toContain("RESTORE_PREPARED");
      expect(existsSync(join(prepared.runRoot, "inventories", "restore-active", "generated-next.jsonl"))).toBe(nextPresent);
      expect(existsSync(join(prepared.runRoot, "inventories", "restore-active", "generated-node-modules.jsonl"))).toBe(modulesPresent);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects an in-progress restore without changing its journal", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const first = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
        stopPhase: "after-event:RESTORE_PREPARED",
      });
      expect(first.ok).toBe(false);
      const before = readFileSync(join(prepared.runRoot, "journal.log"));
      const retry = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      });
      expect(retry.ok).toBe(false);
      expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(before);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("restores a validated run and retains regenerated roots in its rollback namespace", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const validated = invokeQuarantineWorker("mark-validated", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        validatedAt: "2026-08-11T00:00:00.000Z",
        writersStopped: true,
      });
      if (!validated.ok) throw new Error(JSON.stringify(validated));
      const restored = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      });
      if (!restored.ok) throw new Error(JSON.stringify(restored));
      const rollbackRoot = join(
        prepared.runRoot, "rollback", "regenerated-before-restore",
        "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
      );
      expect(readFileSync(join(rollbackRoot, ".next", "build"), "utf8")).toBe("ignored");
      expect(readFileSync(join(rollbackRoot, "node_modules", "package"), "utf8")).toBe("ignored");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });
});
