import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ledgerUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-restore-ledger.mjs")).href;

const manifest = {
  entries: [
    { id: "generated-next", kind: "generated-root" },
    { id: "generated-node-modules", kind: "generated-root" },
    { id: "copy-0001", kind: "source-copy" },
  ],
};

const activeGenerated = [
  { id: "generated-next", inventory: null },
  { id: "generated-node-modules", inventory: null },
];

function build(events: Array<[string, Record<string, unknown>]>) {
  const source = `
    import { buildRestoreLedger } from ${JSON.stringify(ledgerUrl)};
    const events = ${JSON.stringify(events)};
    const manifest = ${JSON.stringify(manifest)};
    try {
      const ledger = buildRestoreLedger({ records: events.map(([event, payload], index) => ({ event, payload, sequence: index + 1 })) }, manifest);
      process.stdout.write(JSON.stringify({ ok: true, restoreId: ledger.restoreId, preRestoreState: ledger.preRestoreState, intents: ledger.intents, completed: [...ledger.completed], records: ledger.records.length }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, message: error.message })); }
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" }));
}

describe("restore recovery epoch ledger", () => {
  it("uses only the second restore epoch after a prior rollback abort", () => {
    const ledger = build([
      ["PREPARED", {}], ["QUARANTINED", {}],
      ["RESTORE_PREPARED", { restoreId: "restore-11111111-1111-4111-8111-111111111111", activeGenerated }],
      ["RESTORING", {}], ["RESTORE_INTENT", { id: "generated-next" }],
      ["RESTORED_ENTRY", { id: "generated-next" }],
      ["RECOVERY_REQUIRED", { entryIds: ["generated-next"] }],
      ["RESTORE_ROLLING_BACK", {}], ["RESTORE_ROLLBACK_INTENT", { id: "generated-next" }],
      ["RESTORE_ROLLED_BACK_ENTRY", { id: "generated-next" }],
      ["RESTORE_ABORTED_TO_QUARANTINED", {}], ["VALIDATED", {}],
      ["RESTORE_PREPARED", { restoreId: "restore-22222222-2222-4222-8222-222222222222", activeGenerated }],
      ["RESTORING", {}], ["RESTORE_INTENT", { id: "generated-next" }],
      ["RECOVERY_REQUIRED", { entryIds: ["generated-next"] }],
    ]);

    expect(ledger.restoreId).toBe("restore-22222222-2222-4222-8222-222222222222");
    expect(ledger.preRestoreState).toBe("VALIDATED");
    expect(ledger.intents).toEqual(["generated-next"]);
    expect(ledger.completed).toEqual([]);
    expect(ledger.records).toBe(4);
  });

  it("rejects a new epoch not immediately anchored in QUARANTINED or VALIDATED", () => {
    expect(build([
      ["PREPARED", {}], ["QUARANTINED", {}],
      ["RESTORE_PREPARED", { restoreId: "restore-11111111-1111-4111-8111-111111111111", activeGenerated }],
      ["RESTORED", {}],
      ["RESTORE_PREPARED", { restoreId: "restore-22222222-2222-4222-8222-222222222222", activeGenerated }],
    ])).toEqual(expect.objectContaining({ ok: false, message: "RESTORE_PREPARED must immediately follow a terminal quarantine state" }));
  });

  it("rejects RECOVERY_REQUIRED evidence that includes a prior epoch intent", () => {
    expect(build([
      ["PREPARED", {}], ["QUARANTINED", {}],
      ["RESTORE_PREPARED", { restoreId: "restore-22222222-2222-4222-8222-222222222222", activeGenerated }],
      ["RESTORING", {}], ["RESTORE_INTENT", { id: "generated-next" }],
      ["RECOVERY_REQUIRED", { entryIds: ["generated-next", "generated-node-modules"] }],
    ])).toEqual(expect.objectContaining({ ok: false, message: "RECOVERY_REQUIRED entryIds does not match the current restore epoch" }));
  });
});
