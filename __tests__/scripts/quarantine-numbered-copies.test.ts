import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createQuarantineFixture } from "../fixtures/quarantine/quarantine-test-harness";

const facadeUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-numbered-copies-support.mjs"),
).href;

const expectedExports = [
  "GENERATED_ROOTS", "IndeterminateJournalAppendError", "activateManifestGeneration",
  "appendJournalRecord", "assertPathUnderRoot", "assertSameDevice", "buildValidatedManifest",
  "canonicalPathForNumberedCopy", "cleanupTerminalJournalArtifacts", "compareInventorySummary",
  "derivePayloadPath", "deriveRunPath", "fsyncTree", "hashFileStream", "inspectWorkspace",
  "markQuarantineValidated", "parseInventoryRecord", "parseInventorySummary", "parseManifestEntry",
  "quarantineWorkspace", "readCurrentManifestPointer", "readManifestGeneration", "reclaimJournalLock",
  "recoverQuarantine", "recoverRestore", "replayJournal", "restoreQuarantine", "revalidateRunCapability",
  "validateTransition", "withJournalLock", "withQuarantineRunCapability", "writeInventoryJsonl", "writeManifestGeneration",
].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));

describe("numbered-copy compatibility facade", () => {
  it("exposes exactly the closed public boundary", async () => {
    expect(facadeKeys()).toEqual(
      expectedExports,
    );
    expect(facadeKeys()).not.toContain("withExistingQuarantineRun");
    expect(facadeKeys()).not.toContain("prepareQuarantineWorkspace");
    expect(facadeKeys()).not.toContain("getRunFsContext");
  });

  it.each([
    ["src/lib/server-env 2.ts", "src/lib/server-env.ts"],
    ["scripts/verify-invalid-startup 3.mjs", "scripts/verify-invalid-startup.mjs"],
  ])("maps the final numbered filename in %s", (input, expected) => {
    expect(invokeFacade("canonicalPathForNumberedCopy", [input])).toBe(expected);
  });

  it.each(["src/lib/version2.ts", "src/lib 2/server-env.ts"])(
    "rejects a non-copy path %s",
    (input) => {
      expect(() => invokeFacade("canonicalPathForNumberedCopy", [input])).toThrow(
        /path is not a numbered copy/u,
      );
    },
  );

  it("retains identical/divergent classification counts", () => {
    const fixture = createQuarantineFixture({ divergent: true });
    try {
      const inspection = invokeFacade("inspectWorkspace", [{
        repoRoot: fixture.repoRoot,
        quarantineRoot: fixture.quarantineRoot,
        expectedBranch: fixture.branch,
        expectedHead: fixture.head,
        expectedCount: fixture.expectedCount,
      }]);
      expect(inspection).toMatchObject({
        status: "INSPECTED",
        sourceCopies: 1,
        generatedRoots: 2,
        identicalCopies: 0,
        divergentCopies: 1,
      });
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

});

function facadeKeys(): string[] {
  const source = `
    import * as facade from ${JSON.stringify(facadeUrl)};
    process.stdout.write(JSON.stringify(Object.keys(facade).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function invokeFacade<T>(operation: string, args: readonly unknown[]): T {
  const source = `
    import * as facade from ${JSON.stringify(facadeUrl)};
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    try {
      const value = await facade[request.operation](...request.args);
      process.stdout.write(JSON.stringify({ ok: true, value }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, name: error?.name, error: error?.message }));
    }
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    input: JSON.stringify({ operation, args }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const response = JSON.parse(output) as
    | { ok: true; value: T }
    | { ok: false; name?: string; error?: string };
  if (!response.ok) {
    throw new Error(`${response.name ?? "Error"}: ${response.error ?? "Unknown facade failure"}`);
  }
  return response.value;
}
