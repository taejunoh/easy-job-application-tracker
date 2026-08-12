import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { prepareQuarantinedFixture, invokeQuarantineWorker } from "../fixtures/quarantine/quarantine-test-harness";

const restoreUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-restore.mjs"),
).href;

function journalEvents(path: string) {
  return journalRecords(path).map((record) => record.event);
}

function journalRecords(path: string): Array<{ event: string; payload: Record<string, unknown> }> {
  const bytes = readFileSync(path);
  const records: Array<{ event: string; payload: Record<string, unknown> }> = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    records.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return records;
}

function generationEvidence(prepared: ReturnType<typeof prepareQuarantinedFixture>) {
  const manifests = join(prepared.runRoot, "manifests");
  const pointer = join(prepared.fixture.quarantineRoot, "current");
  return JSON.stringify({
    pointer: existsSync(pointer) ? readFileSync(pointer).toString("base64") : null,
    manifests: readdirSync(manifests).sort().map((name) => [name, readFileSync(join(manifests, name)).toString("base64")]),
  });
}

const NORMAL_RESTORE_PHASES = [
  "after-inventory:restore-active:generated-next",
  "after-inventory:restore-active:generated-node-modules",
  "after-event:RESTORE_PREPARED",
  "after-event:RESTORING",
  "after-event:RESTORE_INTENT:generated-next",
  "after-active-to-rollback-rename:generated-next",
  "after-rollback-tree-sync:generated-next",
  "after-rollback-destination-parent-sync:generated-next",
  "after-rollback-source-parent-sync:generated-next",
  "after-payload-to-active-rename:generated-next",
  "after-restored-payload-sync:generated-next",
  "after-restore-destination-parent-sync:generated-next",
  "after-restore-source-parent-sync:generated-next",
  "after-event:RESTORED_ENTRY:generated-next",
  "after-event:RESTORE_INTENT:generated-node-modules",
  "after-active-to-rollback-rename:generated-node-modules",
  "after-rollback-tree-sync:generated-node-modules",
  "after-rollback-destination-parent-sync:generated-node-modules",
  "after-rollback-source-parent-sync:generated-node-modules",
  "after-payload-to-active-rename:generated-node-modules",
  "after-restored-payload-sync:generated-node-modules",
  "after-restore-destination-parent-sync:generated-node-modules",
  "after-restore-source-parent-sync:generated-node-modules",
  "after-event:RESTORED_ENTRY:generated-node-modules",
  "after-event:RESTORE_INTENT:copy-0001",
  "after-payload-to-active-rename:copy-0001",
  "after-restored-payload-sync:copy-0001",
  "after-restore-destination-parent-sync:copy-0001",
  "after-restore-source-parent-sync:copy-0001",
  "after-event:RESTORED_ENTRY:copy-0001",
  "after-event:RESTORED",
  "before-lock-cleanup",
] as const;

const EXPECTED_DURABLE_TIP = (() => {
  let current = "QUARANTINED";
  const result: Record<string, string> = {};
  for (const phase of NORMAL_RESTORE_PHASES) {
    if (phase === "after-event:RESTORE_PREPARED") current = "RESTORE_PREPARED";
    else if (phase === "after-event:RESTORING") current = "RESTORING";
    else if (phase.startsWith("after-event:RESTORE_INTENT:")) current = "RESTORE_INTENT";
    else if (phase.startsWith("after-event:RESTORED_ENTRY:")) current = "RESTORED_ENTRY";
    else if (phase === "after-event:RESTORED") current = "RESTORED";
    result[phase] = current;
  }
  return Object.freeze(result) as Record<(typeof NORMAL_RESTORE_PHASES)[number], string>;
})();

describe("quarantine restore", () => {
  it("exports only restoreQuarantine", () => {
    const exports = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const module = await import(${JSON.stringify(restoreUrl)});
      process.stdout.write(JSON.stringify(Object.keys(module)));
    `], { encoding: "utf8" }));
    expect(exports).toEqual(["restoreQuarantine"]);
  });

  it("closes option records before filesystem authority and reads each supplied getter once", async () => {
    const invalid = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const { restoreQuarantine } = await import(${JSON.stringify(restoreUrl)});
      const cases = [Object.create({ repoRoot: "/unused", quarantineRoot: "/unused", transactionId: "tx-0001", writersStopped: true }), {
        repoRoot: "/unused", quarantineRoot: "/unused", transactionId: "tx-0001", writersStopped: true, [Symbol("unknown")]: true,
      }];
      const output = [];
      for (const input of cases) try { await restoreQuarantine(input); } catch (error) { output.push(error.message); }
      process.stdout.write(JSON.stringify(output));
    `], { encoding: "utf8" }));
    expect(invalid).toEqual([expect.stringMatching(/exact record/u), expect.stringMatching(/invalid/u)]);

    const synchronous = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const { restoreQuarantine } = await import(${JSON.stringify(restoreUrl)});
      const counts = { toString: 0, valueOf: 0 }; const hostile = { toString() { counts.toString++; return "/x"; }, valueOf() { counts.valueOf++; return "/x"; } };
      const custom = Object.create({}); Object.assign(custom, { repoRoot: "/r", quarantineRoot: "/q", transactionId: "tx", writersStopped: true });
      const hidden = { repoRoot: "/r", quarantineRoot: "/q", transactionId: "tx", writersStopped: true }; Object.defineProperty(hidden, "extra", { value: true });
      const inherited = Object.create({ repoRoot: "/r" }); Object.assign(inherited, { quarantineRoot: "/q", transactionId: "tx", writersStopped: true });
      const invalid = [null, [], custom, hidden, inherited, { repoRoot: hostile, quarantineRoot: "/q", transactionId: "tx", writersStopped: true }, { repoRoot: "/r", quarantineRoot: "/q", transactionId: "bad id", writersStopped: true }, { repoRoot: "/r", quarantineRoot: "/q", transactionId: "tx", writersStopped: false }];
      const messages = []; for (const input of invalid) try { await restoreQuarantine(input); } catch (error) { messages.push(error.message); }
      process.stdout.write(JSON.stringify({ counts, messages }));
    `], { encoding: "utf8" }));
    expect(synchronous.counts).toEqual({ toString: 0, valueOf: 0 });
    expect(synchronous.messages).toHaveLength(8);

    const prepared = prepareQuarantinedFixture();
    try {
      const output = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
        const { restoreQuarantine } = await import(${JSON.stringify(restoreUrl)});
        const values = ${JSON.stringify({ repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true })};
        const reads = {}; const input = Object.create(null);
        for (const [key, value] of Object.entries(values)) Object.defineProperty(input, key, { enumerable: true, get() { reads[key] = (reads[key] ?? 0) + 1; return value; } });
        const result = await restoreQuarantine(input);
        process.stdout.write(JSON.stringify({ reads, prototype: Object.getPrototypeOf(result) === null, frozen: Object.isFrozen(result), keys: Reflect.ownKeys(result), descriptors: Object.fromEntries(Reflect.ownKeys(result).map((key) => [key, Object.getOwnPropertyDescriptor(result, key)])) }));
      `], { encoding: "utf8" }));
      expect(output.reads).toEqual({ repoRoot: 1, quarantineRoot: 1, transactionId: 1, writersStopped: 1 });
      expect(output.prototype).toBe(true);
      expect(output.frozen).toBe(true);
      expect(output.keys).toEqual(["transactionId", "restoreId", "status", "restoredEntries"]);
      for (const key of output.keys) {
        expect(output.descriptors[key]).toMatchObject({
          enumerable: true, writable: false, configurable: false,
        });
      }
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
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
      expect(result.phases).toEqual([
        "after-inventory:restore-active:generated-next",
        "after-inventory:restore-active:generated-node-modules",
        "after-event:RESTORE_PREPARED",
        "after-event:RESTORING",
        "after-event:RESTORE_INTENT:generated-next",
        "after-active-to-rollback-rename:generated-next",
        "after-rollback-tree-sync:generated-next",
        "after-rollback-destination-parent-sync:generated-next",
        "after-rollback-source-parent-sync:generated-next",
        "after-payload-to-active-rename:generated-next",
        "after-restored-payload-sync:generated-next",
        "after-restore-destination-parent-sync:generated-next",
        "after-restore-source-parent-sync:generated-next",
        "after-event:RESTORED_ENTRY:generated-next",
        "after-event:RESTORE_INTENT:generated-node-modules",
        "after-active-to-rollback-rename:generated-node-modules",
        "after-rollback-tree-sync:generated-node-modules",
        "after-rollback-destination-parent-sync:generated-node-modules",
        "after-rollback-source-parent-sync:generated-node-modules",
        "after-payload-to-active-rename:generated-node-modules",
        "after-restored-payload-sync:generated-node-modules",
        "after-restore-destination-parent-sync:generated-node-modules",
        "after-restore-source-parent-sync:generated-node-modules",
        "after-event:RESTORED_ENTRY:generated-node-modules",
        "after-event:RESTORE_INTENT:copy-0001",
        "after-payload-to-active-rename:copy-0001",
        "after-restored-payload-sync:copy-0001",
        "after-restore-destination-parent-sync:copy-0001",
        "after-restore-source-parent-sync:copy-0001",
        "after-event:RESTORED_ENTRY:copy-0001",
        "after-event:RESTORED",
        "before-lock-cleanup",
      ]);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each(NORMAL_RESTORE_PHASES)("awaits interruption at public restore phase %s without publishing a later journal event", (stopPhase) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const beforeGeneration = generationEvidence(prepared);
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
        stopPhase,
      }, {}, 20_000);
      expect(result.ok).toBe(false);
      const index = NORMAL_RESTORE_PHASES.indexOf(stopPhase);
      expect(result.phases).toEqual(NORMAL_RESTORE_PHASES.slice(0, index + 1));
      expect(generationEvidence(prepared)).toBe(beforeGeneration);
      const durable = EXPECTED_DURABLE_TIP[stopPhase];
      const events = journalEvents(join(prepared.runRoot, "journal.log"));
      expect(events.at(-1)).toBe(durable);
      // The injected hook is awaited inside the operation; it cannot be
      // followed by a later public phase or journal append in this attempt.
      expect(result.phases.slice(index + 1)).toEqual([]);
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
      const preparedRecord = journalRecords(join(prepared.runRoot, "journal.log"))
        .find((record) => record.event === "RESTORE_PREPARED")!;
      const active = preparedRecord.payload.activeGenerated as Array<{ id: string; inventory: unknown }>;
      expect(Object.keys(active)).toEqual(["0", "1"]);
      expect(active.map((entry) => entry.id)).toEqual(["generated-next", "generated-node-modules"]);
      expect(active.map((entry) => entry.inventory === null)).toEqual([!nextPresent, !modulesPresent]);
      for (const entry of active) {
        if (entry.inventory !== null) expect(entry.inventory).toEqual(expect.objectContaining({ sha256: expect.any(String), entries: expect.any(Number), bytes: expect.any(Number) }));
      }
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    ["removes an inventoried root", undefined, "remove-next"],
    ["recreates an absent root", { regenerate: false }, "recreate-modules"],
  ])("rejects final active presence drift before RESTORE_PREPARED: %s", (_label, fixtureOptions, finalPresenceDrift) => {
    const prepared = prepareQuarantinedFixture(fixtureOptions ?? {});
    try {
      if (finalPresenceDrift === "recreate-modules") {
        mkdirSync(join(prepared.fixture.repoRoot, ".next"), { recursive: true, mode: 0o700 });
        writeFileSync(join(prepared.fixture.repoRoot, ".next", "build"), "regenerated\n");
      }
      const beforeJournal = readFileSync(join(prepared.runRoot, "journal.log"));
      const beforeGeneration = generationEvidence(prepared);
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true, finalPresenceDrift,
      });
      expect(result.ok).toBe(false);
      expect(journalEvents(join(prepared.runRoot, "journal.log"))).not.toContain("RESTORE_PREPARED");
      expect(readFileSync(join(prepared.runRoot, "journal.log")).subarray(0, beforeJournal.length)).toEqual(beforeJournal);
      expect(generationEvidence(prepared)).toBe(beforeGeneration);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    [true, true], [true, false], [false, true], [false, false],
  ])("preserves the dense activeGenerated provenance for VALIDATED (%s, %s)", (nextPresent, modulesPresent) => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    try {
      const validated = invokeQuarantineWorker("mark-validated", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, validatedAt: "2026-08-11T00:00:00.000Z", writersStopped: true,
      });
      if (!validated.ok) throw new Error(JSON.stringify(validated));
      for (const [present, directory, file] of [[nextPresent, ".next", "build"], [modulesPresent, "node_modules", "package"]] as const) {
        if (!present) continue;
        mkdirSync(join(prepared.fixture.repoRoot, directory), { recursive: true, mode: 0o700 });
        writeFileSync(join(prepared.fixture.repoRoot, directory, file), "regenerated\n");
      }
      const restored = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      });
      if (!restored.ok) throw new Error(JSON.stringify(restored));
      const active = journalRecords(join(prepared.runRoot, "journal.log"))
        .find((record) => record.event === "RESTORE_PREPARED")!.payload.activeGenerated as Array<{ id: string; inventory: unknown }>;
      expect(active.map((entry) => entry.id)).toEqual(["generated-next", "generated-node-modules"]);
      expect(active.map((entry) => entry.inventory === null)).toEqual([!nextPresent, !modulesPresent]);
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

  it("preserves an interloper observed at the final cooperative source destination precheck", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const before = readFileSync(join(prepared.runRoot, "journal.log"));
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
        interloperAtFinalPrecheck: "source-active",
      });
      expect(result.ok).toBe(false);
      if ((result as unknown as { finalPrecheckTargetReads?: number }).finalPrecheckTargetReads !== 1) throw new Error(JSON.stringify(result));
      expect(readFileSync(join(prepared.fixture.repoRoot, prepared.fixture.copyPath!), "utf8")).toBe("foreign interloper\n");
      expect(readFileSync(join(prepared.runRoot, "journal.log")).subarray(0, before.length)).toEqual(before);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("preserves a generated interloper observed at its final payload-to-active precheck", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
        interloperAtFinalPrecheck: "generated-active",
      });
      expect(result.ok).toBe(false);
      if ((result as unknown as { finalPrecheckTargetReads?: number }).finalPrecheckTargetReads !== 1) throw new Error(JSON.stringify(result));
      expect(readFileSync(join(prepared.fixture.repoRoot, ".next", "foreign"), "utf8")).toBe("foreign interloper\n");
      expect(journalEvents(join(prepared.runRoot, "journal.log")).at(-1)).toBe("RESTORE_INTENT");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("preserves a generated interloper observed at the final active-to-rollback destination precheck", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true, interloperAtFinalPrecheck: "generated-rollback",
      });
      expect(result.ok).toBe(false);
      expect((result as unknown as { finalPrecheckTargetReads: number }).finalPrecheckTargetReads).toBe(1);
      expect(journalEvents(join(prepared.runRoot, "journal.log")).at(-1)).toBe("RESTORE_INTENT");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a byte-identical foreign repository ancestor exchanged after active inventory publication", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const before = readFileSync(join(prepared.runRoot, "journal.log"));
      const generation = generationEvidence(prepared);
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true, ancestorExchangeAt: "after-inventory",
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(join(prepared.fixture.repoRoot, "foreign-sentinel"), "utf8")).toBe("foreign");
      expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(before);
      expect(generationEvidence(prepared)).toBe(generation);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a byte-identical repository exchange after verified summary and before inventory publication", () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const before = readFileSync(join(prepared.runRoot, "journal.log"));
      const result = invokeQuarantineWorker("restore", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true, ancestorExchangeAt: "before-publication",
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(join(prepared.fixture.repoRoot, "foreign-sentinel"), "utf8")).toBe("foreign");
      expect(readFileSync(join(prepared.runRoot, "journal.log"))).toEqual(before);
      expect(journalEvents(join(prepared.runRoot, "journal.log"))).not.toContain("RESTORE_PREPARED");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    ["QUARANTINED rollback before its first held sync", "QUARANTINED", "rollback"],
    ["VALIDATED rollback before its first held sync", "VALIDATED", "rollback"],
    ["QUARANTINED restored generated root before its first held sync", "QUARANTINED", "restored-generated"],
    ["VALIDATED restored source before its first held sync", "VALIDATED", "restored-source"],
  ])("never follows a replaced tree at %s", (_label, provenance, target) => {
    const prepared = prepareQuarantinedFixture();
    try {
      if (provenance === "VALIDATED") {
        const validated = invokeQuarantineWorker("mark-validated", {
          repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId, validatedAt: "2026-08-11T00:00:00.000Z", writersStopped: true,
        });
        expect(validated.ok).toBe(true);
      }
      const result = invokeQuarantineWorker("restore-authority-seam", {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true, target,
      }) as unknown as {
        ok: boolean; injected: boolean; externalReads: number; externalSync: number;
        foreignIntact: boolean; evidenceStable: boolean; error?: { message: string };
      };
      expect(result.injected).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.externalReads).toBe(0);
      expect(result.externalSync).toBe(0);
      expect(result.foreignIntact).toBe(true);
      expect(result.evidenceStable).toBe(true);
      expect(result.error?.message).toMatch(/changed|identity|unsafe/u);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  });
});
