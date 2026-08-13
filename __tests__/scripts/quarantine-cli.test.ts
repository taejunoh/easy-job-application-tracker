import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  createQuarantineFixture,
  prepareQuarantinedFixture,
  spawnLifecycleChild,
} from "../fixtures/quarantine/quarantine-test-harness";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function run(args: string[]) {
  const env = { ...process.env };
  delete env.npm_config_loglevel;
  return spawnSync("npm", ["run", "cleanup:quarantine", "--", ...args], {
    cwd: join(__dirname, "../.."), encoding: "utf8",
    env, timeout: 15_000, killSignal: "SIGKILL",
  });
}

function expectSpawned(result: ReturnType<typeof run>) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
}

function inspectArgs(fixture: ReturnType<typeof createQuarantineFixture>) {
  return [
    "inspect", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
    "--expected-branch", fixture.branch, "--expected-head", fixture.head,
    "--expected-count", String(fixture.expectedCount),
  ];
}

function applyArgs(fixture: ReturnType<typeof createQuarantineFixture>) {
  return [
    ...inspectArgs(fixture).map((value) => value === "inspect" ? "apply" : value),
    "--transaction-id", "operator-tx-0001", "--writers-stopped",
  ];
}

describe("quarantine cleanup CLI", () => {
  it("runs the canonical inspect npm form and emits its exact public record", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);

    const result = run(inspectArgs(fixture));

    expectSpawned(result);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.match(/\n/g)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, command: "inspect", status: "INSPECTED", schemaVersion: 2, sourceCopies: 1,
      tempResidues: 0,
      generatedRoots: 2, identicalCopies: 1, divergentCopies: 0,
    });
  });

  it("runs apply then mark-validated through their canonical npm forms", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);

    const applied = run(applyArgs(fixture));
    expectSpawned(applied);
    const records = applied.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe("");
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      ok: true, command: "apply", status: "STARTING", schemaVersion: 2,
      transactionId: "operator-tx-0001",
    });
    expect(records[1]).toEqual({
      ok: true, command: "apply", status: "QUARANTINED", schemaVersion: 2,
      transactionId: records[0].transactionId,
      movedEntries: 3, manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    mkdirSync(join(fixture.repoRoot, ".next"), { mode: 0o700 });
    mkdirSync(join(fixture.repoRoot, "node_modules"), { mode: 0o700 });
    writeFileSync(join(fixture.repoRoot, ".next", "build"), "ignored");
    writeFileSync(join(fixture.repoRoot, "node_modules", "package"), "ignored");

    const validated = run([
      "mark-validated", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", records[0].transactionId, "--writers-stopped",
    ]);
    expect(validated.status).toBe(0);
    expect(validated.stderr).toBe("");
    expectSpawned(validated);
    expect(JSON.parse(validated.stdout)).toEqual({
      ok: true, command: "mark-validated", status: "VALIDATED", transactionId: records[0].transactionId,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      validatedAt: expect.any(String), deleteAfter: expect.any(String), deletionRequiresConfirmation: true,
    });
  });

  it.each([
    ["restore", (fixture: ReturnType<typeof createQuarantineFixture>) => [
      "restore", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "missing-run", "--writers-stopped",
    ]],
    ["mark-validated", (fixture: ReturnType<typeof createQuarantineFixture>) => [
      "mark-validated", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "missing-run", "--writers-stopped",
    ]],
    ["recover", (fixture: ReturnType<typeof createQuarantineFixture>) => [
      "recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "missing-run", "--action", "resume", "--writers-stopped",
    ]],
  ])("classifies a missing selected run as integrity evidence for %s", (command, argsFor) => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);

    const result = run(argsFor(fixture));

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `{\"ok\":false,\"command\":\"${command}\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n`,
    );
  });

  it.each([
    ["restore", (fixture: ReturnType<typeof createQuarantineFixture>) => [
      "restore", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "missing-run", "--writers-stopped",
    ]],
    ["mark-validated", (fixture: ReturnType<typeof createQuarantineFixture>) => [
      "mark-validated", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "missing-run", "--writers-stopped",
    ]],
    ["recover", (fixture: ReturnType<typeof createQuarantineFixture>) => [
      "recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "missing-run", "--action", "resume", "--writers-stopped",
    ]],
  ])("classifies a missing %s root as preflight failure for %s", (command, argsFor) => {
    for (const targetFor of [
      (fixture: ReturnType<typeof createQuarantineFixture>) => fixture.repoRoot,
      (fixture: ReturnType<typeof createQuarantineFixture>) => fixture.quarantineRoot,
    ]) {
      const fixture = createQuarantineFixture();
      bases.push(fixture.base);
      rmSync(targetFor(fixture), { recursive: true, force: true });

      const result = run(argsFor(fixture));

      expectSpawned(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`{\"ok\":false,\"command\":\"${command}\",\"code\":\"ERR_PREFLIGHT\",\"message\":\"Workspace preflight failed.\"}\n`);
    }
  });

  it("flushes apply STARTING before an indeterminate journal append failure", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const mockPath = join(fixture.base, "cli-fault-facade.mjs");
    const loaderPath = join(fixture.base, "cli-fault-loader.mjs");
    const journalUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-journal.mjs")).href;
    const mockUrl = pathToFileURL(mockPath).href;
    writeFileSync(mockPath, `
      import { IndeterminateJournalAppendError } from ${JSON.stringify(journalUrl)};
      export async function quarantineWorkspace() {
        throw new IndeterminateJournalAppendError({ cause: new Error("test fault"), expectedSequence: 1, expectedRecordHash: "0".repeat(64) });
      }
      export async function inspectWorkspace() { throw new Error("unused"); }
      export async function markQuarantineValidated() { throw new Error("unused"); }
      export async function recoverQuarantine() { throw new Error("unused"); }
      export async function recoverRestore() { throw new Error("unused"); }
      export async function restoreQuarantine() { throw new Error("unused"); }
    `);
    writeFileSync(loaderPath, `
      const mockUrl = ${JSON.stringify(mockUrl)};
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "./quarantine-numbered-copies-support.mjs") return { url: mockUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `);

    const registerLoader = `data:text/javascript,${encodeURIComponent(`
      import { register } from "node:module";
      import { pathToFileURL } from "node:url";
      register(${JSON.stringify(loaderPath)}, pathToFileURL("./"));
    `)}`;
    const result = spawnSync(process.execPath, [
      "--import", registerLoader, "scripts/quarantine-numbered-copies.mjs", ...applyArgs(fixture),
    ], {
      cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(4);
    const starting = JSON.parse(result.stdout);
    expect(starting).toEqual({
      ok: true, command: "apply", status: "STARTING", transactionId: expect.stringMatching(/^cli-[0-9a-f-]{36}$/u),
    });
    expect(result.stdout).toBe(`${JSON.stringify(starting)}\n`);
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"apply\",\"code\":\"ERR_INDETERMINATE_JOURNAL_APPEND\",\"message\":\"Journal durability could not be determined.\"}\n");
  });

  it("keeps an untyped facade failure internal after apply STARTING", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const mockPath = join(fixture.base, "cli-internal-facade.mjs");
    const loaderPath = join(fixture.base, "cli-internal-loader.mjs");
    const mockUrl = pathToFileURL(mockPath).href;
    writeFileSync(mockPath, `
      export async function quarantineWorkspace() { throw new Error("programmer fault"); }
      export async function inspectWorkspace() { throw new Error("unused"); }
      export async function markQuarantineValidated() { throw new Error("unused"); }
      export async function recoverQuarantine() { throw new Error("unused"); }
      export async function recoverRestore() { throw new Error("unused"); }
      export async function restoreQuarantine() { throw new Error("unused"); }
    `);
    writeFileSync(loaderPath, `
      const mockUrl = ${JSON.stringify(mockUrl)};
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "./quarantine-numbered-copies-support.mjs") return { url: mockUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `);
    const registerLoader = `data:text/javascript,${encodeURIComponent(`
      import { register } from "node:module";
      import { pathToFileURL } from "node:url";
      register(${JSON.stringify(loaderPath)}, pathToFileURL("./"));
    `)}`;

    const result = spawnSync(process.execPath, [
      "--import", registerLoader, "scripts/quarantine-numbered-copies.mjs", ...applyArgs(fixture),
    ], {
      cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const starting = JSON.parse(result.stdout);
    expect(starting).toEqual({
      ok: true, command: "apply", status: "STARTING", transactionId: expect.stringMatching(/^cli-[0-9a-f-]{36}$/u),
    });
    expect(result.stdout).toBe(`${JSON.stringify(starting)}\n`);
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"apply\",\"code\":\"ERR_INTERNAL\",\"message\":\"Unexpected quarantine failure.\"}\n");
  });

  it("does not convert an unknown restore-recovery exception into apply integrity", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const mockPath = join(fixture.base, "cli-recovery-facade.mjs");
    const loaderPath = join(fixture.base, "cli-recovery-loader.mjs");
    const mockUrl = pathToFileURL(mockPath).href;
    writeFileSync(mockPath, `
      export async function recoverQuarantine() { throw Object.freeze({ code: "ERR_INTEGRITY" }); }
      export async function recoverRestore() { throw new Error("unexpected recovery fault"); }
      export async function inspectWorkspace() { throw new Error("unused"); }
      export async function quarantineWorkspace() { throw new Error("unused"); }
      export async function markQuarantineValidated() { throw new Error("unused"); }
      export async function restoreQuarantine() { throw new Error("unused"); }
    `);
    writeFileSync(loaderPath, `
      const mockUrl = ${JSON.stringify(mockUrl)};
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "./quarantine-numbered-copies-support.mjs") return { url: mockUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `);
    const registerLoader = `data:text/javascript,${encodeURIComponent(`
      import { register } from "node:module";
      import { pathToFileURL } from "node:url";
      register(${JSON.stringify(loaderPath)}, pathToFileURL("./"));
    `)}`;
    const result = spawnSync(process.execPath, [
      "--import", registerLoader, "scripts/quarantine-numbered-copies.mjs",
      "recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "tx-0001", "--action", "resume", "--writers-stopped",
    ], {
      cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"recover\",\"code\":\"ERR_INTERNAL\",\"message\":\"Unexpected quarantine failure.\"}\n");
  });

  it("runs restore through its canonical npm form", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, command: "restore", status: "RESTORED", transactionId: prepared.transactionId,
      restoreId: expect.stringMatching(/^restore-[0-9a-f-]{36}$/u), restoredEntries: 3,
    });
  });

  it.each(["resume", "rollback"] as const)("runs recover %s through its canonical npm form", (action) => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", action, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(action === "resume" ? 0 : 2);
    if (action === "resume") {
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true, command: "recover", result: {
          transactionId: prepared.transactionId, status: "QUARANTINED", action: "resume", reconciledEntries: 0,
        },
      });
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, command: "recover", code: "ERR_USAGE", message: "Invalid quarantine request." });
    }
  });

  it("routes an interrupted restore recovery through the canonical npm form", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_PREPARED",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", "resume", "--writers-stopped",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, command: "recover", result: {
        transactionId: prepared.transactionId, restoreId: expect.stringMatching(/^restore-[0-9a-f-]{36}$/u),
        status: "RESTORED", action: "resume", reconciledEntries: 3,
      },
    });
  });

  it("kills and awaits a timed-out lifecycle child without later phases", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const trace = join(prepared.fixture.base, "timed-child-phases.log");
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    const result = await spawnLifecycleChild("restoreQuarantine", options, {
      hangAt: "after-inventory:restore-active:generated-next", phaseTracePath: trace, timeoutMs: 1_000,
    });

    expect(result.signal).toBe("SIGKILL");
    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(trace, "utf8")).toBe("after-inventory:restore-active:generated-next\n");
  });

  it("converts recovery conflicts to ERR_CONFLICT without exposing entry identifiers", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_INTENT:copy-0001",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));
    writeFileSync(join(prepared.fixture.repoRoot, "notes 2.txt"), "canonical\n");

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", "resume", "--writers-stopped",
    ]);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false, command: "recover", code: "ERR_CONFLICT", message: "Quarantine recovery found preserved conflicts.",
    });
    expect(result.stderr).not.toContain("copy-0001");
  });

  it.each([
    ["missing payload", (prepared: ReturnType<typeof prepareQuarantinedFixture>) => rmSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"))],
    ["tampered payload", (prepared: ReturnType<typeof prepareQuarantinedFixture>) => writeFileSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"), "tampered\n")],
  ])("classifies restore %s evidence as integrity failure", (_caseName, mutate) => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    mutate(prepared);

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it.each([
    ["missing generated payload", (prepared: ReturnType<typeof prepareQuarantinedFixture>) => rmSync(join(prepared.runRoot, "payload", "generated", ".next"), { recursive: true })],
    ["tampered generated payload", (prepared: ReturnType<typeof prepareQuarantinedFixture>) => writeFileSync(join(prepared.runRoot, "payload", "generated", ".next", "build"), "tampered\n")],
  ])("classifies restore %s as integrity failure", (_caseName, mutate) => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    mutate(prepared);

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("classifies a generated payload root symlink as integrity failure", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const payload = join(prepared.runRoot, "payload", "generated", ".next");
    rmSync(payload, { recursive: true });
    symlinkSync("../node_modules", payload);

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it.each([
    ["regular file", (payload: string) => {
      rmSync(payload, { recursive: true });
      writeFileSync(payload, "not a generated directory\n");
    }],
    ["nested symlink", (payload: string) => symlinkSync("build", join(payload, "unexpected-link"))],
  ])("classifies a generated payload %s as integrity failure", (_caseName, mutate) => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    mutate(join(prepared.runRoot, "payload", "generated", ".next"));

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("classifies tampered lifecycle evidence as integrity failure", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    writeFileSync(join(prepared.runRoot, "journal.log"), "tampered");

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("keeps an injected journal adapter exception internal", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const restoreUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-restore-internal.mjs")).href;
    const script = `
      import { restoreQuarantine } from ${JSON.stringify(restoreUrl)};
      import * as promises from "node:fs/promises";
      import { createReadStream, lstatSync, realpathSync } from "node:fs";
      const fsApi = { ...promises, createReadStream, lstatSync, realpathSync };
      const open = fsApi.open;
      fsApi.open = async (path, ...args) => {
        if (path.endsWith("/journal.log")) throw new Error("injected adapter fault");
        return open(path, ...args);
      };
      try {
        await restoreQuarantine({ ...${JSON.stringify({
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          writersStopped: true,
        })}, fsApi });
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error?.code ?? null }) + "\\n");
      }
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("{\"code\":null}\n");
  });

  it("classifies journal corruption after restore handoff as integrity failure", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const restoreUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-restore-internal.mjs")).href;
    const loaderPath = join(prepared.fixture.base, "post-handoff-journal-loader.mjs");
    writeFileSync(loaderPath, `
      import { readFile } from "node:fs/promises";
      export async function load(url, context, nextLoad) {
        const loaded = await nextLoad(url, context);
        if (url !== ${JSON.stringify(restoreUrl)}) return loaded;
        const original = await readFile(new URL(url), "utf8");
        if (!original.includes("const replayed = await replayJournalForRestore(handoff.capability);")) {
          throw new Error("post-handoff journal seam is missing");
        }
        const source = original.replace(
          "const replayed = await replayJournalForRestore(handoff.capability);",
          "await (await import('node:fs/promises')).writeFile(join(options.quarantineRoot, options.transactionId, 'journal.log'), 'tampered'); const replayed = await replayJournalForRestore(handoff.capability);",
        );
        return { format: "module", source, shortCircuit: true };
      }
    `);
    const registerLoader = `data:text/javascript,${encodeURIComponent(`
      import { register } from "node:module";
      import { pathToFileURL } from "node:url";
      register(${JSON.stringify(loaderPath)}, pathToFileURL("./"));
    `)}`;

    const result = spawnSync(process.execPath, [
      "--import", registerLoader, "scripts/quarantine-numbered-copies.mjs",
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ], { cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("classifies malformed manifest evidence as integrity failure", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const [manifest] = readdirSync(join(prepared.runRoot, "manifests"));
    writeFileSync(join(prepared.runRoot, "manifests", manifest), "malformed");

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("classifies a missing manifest generation as integrity failure", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const [manifest] = readdirSync(join(prepared.runRoot, "manifests"));
    rmSync(join(prepared.runRoot, "manifests", manifest));

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("keeps an injected manifest adapter exception internal", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const restoreUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-restore.mjs")).href;
    const script = `
      import { restoreQuarantine } from ${JSON.stringify(restoreUrl)};
      import * as promises from "node:fs/promises";
      import { createReadStream, lstatSync, realpathSync } from "node:fs";
      const fsApi = { ...promises, createReadStream, lstatSync, realpathSync };
      const lstat = fsApi.lstat;
      fsApi.lstat = async (path, ...args) => {
        if (path.includes("/manifests/")) throw new Error("injected adapter fault");
        return lstat(path, ...args);
      };
      try {
        await restoreQuarantine({ ...${JSON.stringify({
          repoRoot: prepared.fixture.repoRoot,
          quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId,
          writersStopped: true,
        })}, fsApi });
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error?.code ?? null }) + "\\n");
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("{\"code\":null}\n");
  });

  it("classifies malformed current-pointer evidence as integrity failure", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const marked = run([
      "mark-validated", "--repo-root", prepared.fixture.repoRoot,
      "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);
    expectSpawned(marked);
    expect(marked.status).toBe(0);
    writeFileSync(join(prepared.fixture.quarantineRoot, "current"), "malformed");

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_INTEGRITY\",\"message\":\"Quarantine evidence failed integrity validation.\"}\n");
  });

  it("classifies an in-progress restore as explicit recovery required", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_PREPARED",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("{\"ok\":false,\"command\":\"restore\",\"code\":\"ERR_RECOVERY_REQUIRED\",\"message\":\"Explicit quarantine recovery is required.\"}\n");
  });

  it("rolls an interrupted restore back through the canonical recover form", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_PREPARED",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", "rollback", "--writers-stopped",
    ]);

    expectSpawned(result);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, command: "recover", result: {
        transactionId: prepared.transactionId, restoreId: expect.stringMatching(/^restore-[0-9a-f-]{36}$/u),
        status: "QUARANTINED", action: "rollback", reconciledEntries: 0, restoreAborted: true,
      },
    });
  });

  it("rejects malformed commands and invalid parser inputs without leaking raw tokens", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const sensitive = "https://user:secret@example.invalid/path?authorization=Bearer+raw";
    const cases = [
      ["unknown", sensitive],
      [...inspectArgs(fixture), "--expected-count", "2"],
      [...inspectArgs(fixture), "--writers-stopped"],
      ["inspect", "--repo-root", "relative", "--quarantine-root", fixture.quarantineRoot, "--expected-branch", fixture.branch, "--expected-head", fixture.head, "--expected-count", "1"],
      ["recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "550e8400-e29b-41d4-a716-446655440000", "--action", "resume", "--writers-stopped"],
    ];
    for (const args of cases) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      const failure = JSON.parse(result.stderr);
      expect(failure).toEqual({
        ok: false, command: args[0] === "unknown" ? null : args[0], code: "ERR_USAGE", message: "Invalid quarantine request.",
      });
      expect(result.stderr).not.toContain(sensitive);
    }
  });

  it("requires writers-stopped for every mutating command", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const missingAttestation = [
      applyArgs(fixture).slice(0, -1),
      ["recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "tx-1", "--action", "resume"],
      ["mark-validated", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "tx-1"],
      ["restore", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "tx-1"],
    ];
    for (const args of missingAttestation) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false, command: args[0], code: "ERR_USAGE", message: "Invalid quarantine request.",
      });
    }
  });

  it("uses direct node execution only in this bounded internal harness", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const result = spawnSync(process.execPath, ["scripts/quarantine-numbered-copies.mjs", ...inspectArgs(fixture)], {
      cwd: join(__dirname, "../.."), encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, command: "inspect", status: "INSPECTED", sourceCopies: 1,
      generatedRoots: 2, identicalCopies: 1, divergentCopies: 0,
    });
  });
});
