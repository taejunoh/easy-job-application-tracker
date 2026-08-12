import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  invokeQuarantineWorker,
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
});
