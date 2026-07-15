import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-capability.mjs"),
).href;
const TRANSACTION_ID = "cleanup.2026-07-15_A";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const RESTORE_ID = `restore-${UUID}`;
const DIGEST = "a".repeat(64);

type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  runRoot: string;
};

type WorkerResult = {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
};

const runDirectories = [
  "manifests",
  "inventories/pre",
  "inventories/moved-pass-1",
  "inventories/moved-pass-2",
  "inventories/restore-active",
  "inventories/work",
  "payload/source-copies",
  "payload/generated",
  "rollback/regenerated-before-restore",
  "conflicts",
  "divergent-diffs",
];

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function createRunDirectories(runRoot: string) {
  for (const relativePath of runDirectories) {
    privateDirectory(join(runRoot, relativePath));
  }
}

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "quarantine-capability-"));
  const repoRoot = join(base, "repo");
  const quarantineRoot = join(base, "quarantine");
  const runRoot = join(quarantineRoot, TRANSACTION_ID);
  privateDirectory(repoRoot);
  privateDirectory(quarantineRoot);
  privateDirectory(runRoot);
  createRunDirectories(runRoot);
  return {
    base: realpathSync(base),
    repoRoot: realpathSync(repoRoot),
    quarantineRoot: realpathSync(quarantineRoot),
    runRoot: realpathSync(runRoot),
  };
}

function invoke(fixture: Fixture, request: Record<string, unknown>): WorkerResult {
  const source = `
import * as capabilityModule from ${JSON.stringify(moduleUrl)};
import * as fsPromises from "node:fs/promises";
import { chmodSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const runDirectories = ${JSON.stringify(runDirectories)};

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function createRunDirectories(runRoot) {
  for (const relativePath of runDirectories) privateDirectory(join(runRoot, relativePath));
}

function errorDetails(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error) };
}

async function capture(callback) {
  try {
    return { threw: false, value: await callback() };
  } catch (error) {
    return { threw: true, error: errorDetails(error) };
  }
}

function options(overrides = {}) {
  return {
    repoRoot: request.fixture.repoRoot,
    quarantineRoot: request.fixture.quarantineRoot,
    transactionId: request.transactionId ?? ${JSON.stringify(TRANSACTION_ID)},
    writersStopped: request.writersStopped ?? true,
    ...overrides,
  };
}

async function run() {
  const {
    deriveRunPath,
    revalidateRunCapability,
    withQuarantineRunCapability,
  } = capabilityModule;

  if (request.operation === "open") {
    return withQuarantineRunCapability(options(request.options), async () => "called");
  }
  if (request.operation === "derive-many") {
    return withQuarantineRunCapability(options(), async (capability) =>
      request.requests.map((pathRequest) => deriveRunPath(capability, pathRequest))
    );
  }
  if (request.operation === "derive-error") {
    return withQuarantineRunCapability(options(), async (capability) =>
      capture(() => deriveRunPath(capability, request.pathRequest))
    );
  }
  if (request.operation === "forged") {
    return {
      derive: await capture(() => deriveRunPath({}, { purpose: "journal" })),
      revalidate: await capture(() => revalidateRunCapability({}, {
        purpose: "journal",
        boundary: "before-mutation",
      })),
    };
  }
  if (request.operation === "leak-resolve") {
    let leaked;
    const settlement = await capture(() => withQuarantineRunCapability(options(), async (capability) => {
      leaked = capability;
      deriveRunPath(capability, { purpose: "journal" });
      return "resolved";
    }));
    return {
      settlement,
      derive: await capture(() => deriveRunPath(leaked, { purpose: "journal" })),
      revalidate: await capture(() => revalidateRunCapability(leaked, {
        purpose: "journal",
        boundary: "after-sync",
      })),
    };
  }
  if (request.operation === "leak-reject") {
    let leaked;
    const settlement = await capture(() => withQuarantineRunCapability(options(), async (capability) => {
      leaked = capability;
      throw new Error("callback failed");
    }));
    return {
      settlement,
      derive: await capture(() => deriveRunPath(leaked, { purpose: "journal" })),
    };
  }
  if (request.operation === "device-mismatch") {
    const fsApi = {
      ...fsPromises,
      lstat: async (path) => {
        const stat = await fsPromises.lstat(path);
        if (path !== request.fixture.quarantineRoot) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "dev") return Number(target.dev) + 1;
            return Reflect.get(target, property, target);
          },
        });
      },
    };
    return withQuarantineRunCapability(options({ fsApi }), async () => "called");
  }
  if (request.operation === "replace-root") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const replacedPath = request.target === "quarantine"
        ? request.fixture.quarantineRoot
        : request.fixture.runRoot;
      renameSync(replacedPath, replacedPath + ".original");
      privateDirectory(replacedPath);
      if (request.target === "quarantine") privateDirectory(request.fixture.runRoot);
      createRunDirectories(request.fixture.runRoot);
      return {
        derive: await capture(() => deriveRunPath(capability, { purpose: "journal" })),
        revalidate: await capture(() => revalidateRunCapability(capability, {
          purpose: "journal",
          boundary: "before-mutation",
        })),
      };
    });
  }
  if (request.operation === "replace-parent") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const derived = deriveRunPath(capability, request.pathRequest);
      const parent = dirname(derived);
      renameSync(parent, parent + ".original");
      symlinkSync(request.external, parent);
      return {
        parent,
        derive: await capture(() => deriveRunPath(capability, request.pathRequest)),
        before: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "before-mutation",
        })),
        after: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "after-sync",
        })),
      };
    });
  }
  if (request.operation === "parent-mode") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const derived = deriveRunPath(capability, request.pathRequest);
      chmodSync(dirname(derived), 0o755);
      return {
        derive: await capture(() => deriveRunPath(capability, request.pathRequest)),
        before: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "before-mutation",
        })),
        after: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "after-sync",
        })),
      };
    });
  }
  throw new Error("unknown worker operation");
}

try {
  process.stdout.write(JSON.stringify({ ok: true, value: await run() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: errorDetails(error) }));
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    input: JSON.stringify({ ...request, fixture }),
  });
  if (result.status !== 0) {
    throw new Error(`capability worker failed (${result.status}): ${result.stderr}`);
  }
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout) as WorkerResult;
  expect(typeof parsed.ok).toBe("boolean");
  if (parsed.ok) {
    expect(parsed).toHaveProperty("value");
  } else {
    expect(parsed.error).toEqual({
      name: expect.any(String),
      message: expect.any(String),
    });
  }
  return parsed;
}

function workerValue(result: WorkerResult) {
  expect(result.ok).toBe(true);
  return result.value as Record<string, unknown>;
}

function expectCapturedError(value: unknown, pattern: RegExp) {
  expect(value).toMatchObject({
    threw: true,
    error: { name: expect.any(String), message: expect.stringMatching(pattern) },
  });
}

describe("callback-scoped quarantine run capability", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it("derives the complete closed path table from the approved real roots", () => {
    const requests = [
      { purpose: "journal" },
      { purpose: "journal-lock" },
      { purpose: "journal-tombstone", id: UUID },
      { purpose: "manifest-generation", id: DIGEST },
      { purpose: "manifest-temporary", id: UUID },
      { purpose: "current-pointer" },
      { purpose: "current-temporary", id: UUID },
      { purpose: "inventory", phase: "pre", id: "copy-0001" },
      { purpose: "inventory", phase: "restore-active", id: RESTORE_ID },
      { purpose: "inventory-work", id: UUID },
      { purpose: "payload", id: "copy-0001" },
      { purpose: "payload", id: "generated-next" },
      { purpose: "payload", id: "generated-node-modules" },
      { purpose: "rollback", id: RESTORE_ID },
      { purpose: "conflict", id: "generated-node-modules" },
      { purpose: "divergent-diff", id: "copy-0042" },
    ];
    const expected = [
      join(fixture.runRoot, "journal.log"),
      join(fixture.runRoot, "journal.lock"),
      join(fixture.runRoot, `journal.lock.tombstone.${UUID}`),
      join(fixture.runRoot, "manifests", `${DIGEST}.json`),
      join(fixture.runRoot, "manifests", `.${UUID}.tmp`),
      join(fixture.quarantineRoot, "current"),
      join(fixture.quarantineRoot, `.current.${UUID}.tmp`),
      join(fixture.runRoot, "inventories", "pre", "copy-0001.jsonl"),
      join(fixture.runRoot, "inventories", "restore-active", `${RESTORE_ID}.jsonl`),
      join(fixture.runRoot, "inventories", "work", `${UUID}.bin`),
      join(fixture.runRoot, "payload", "source-copies", "copy-0001"),
      join(fixture.runRoot, "payload", "generated", ".next"),
      join(fixture.runRoot, "payload", "generated", "node_modules"),
      join(fixture.runRoot, "rollback", "regenerated-before-restore", RESTORE_ID),
      join(fixture.runRoot, "conflicts", "generated-node-modules"),
      join(fixture.runRoot, "divergent-diffs", "copy-0042.patch"),
    ];

    expect(workerValue(invoke(fixture, { operation: "derive-many", requests }))).toEqual(expected);

    const callerPath = join(fixture.base, "caller-selected");
    const injected = workerValue(
      invoke(fixture, {
        operation: "derive-error",
        pathRequest: { purpose: "journal", path: callerPath },
      }),
    );
    expectCapturedError(injected, /field|request/u);
    expect(expected).not.toContain(callerPath);
  });

  it.each([false, null, 1, "true"])(
    "requires literal writersStopped=true: %p",
    (writersStopped) => {
      const result = invoke(fixture, {
        operation: "open",
        options: { writersStopped },
      });
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/writers|attest/u) } });
    },
  );

  it("rejects forged capabilities", () => {
    const value = workerValue(invoke(fixture, { operation: "forged" }));
    expectCapturedError(value.derive, /capability/u);
    expectCapturedError(value.revalidate, /capability/u);
  });

  it.each(["leak-resolve", "leak-reject"])(
    "deactivates leaked capabilities after %s callback settlement",
    (operation) => {
      const value = workerValue(invoke(fixture, { operation }));
      expectCapturedError(value.derive, /inactive|capability/u);
      if (operation === "leak-resolve") {
        expect(value.settlement).toMatchObject({ threw: false, value: "resolved" });
        expectCapturedError(value.revalidate, /inactive|capability/u);
      } else {
        expectCapturedError(value.settlement, /callback failed/u);
      }
    },
  );

  it.each([
    { purpose: "unknown" },
    { purpose: "journal", id: UUID },
    { purpose: "journal", phase: "pre" },
    { purpose: "manifest-generation" },
    { purpose: "manifest-generation", id: DIGEST, phase: "pre" },
    { purpose: "inventory", id: "copy-0001" },
    { purpose: "inventory", phase: "pre" },
    { purpose: "inventory", id: "copy-0001", phase: "later" },
    { purpose: "inventory-work", id: UUID, phase: "pre" },
  ])("rejects invalid purpose/id/phase combinations: %o", (pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "derive-error", pathRequest }));
    expectCapturedError(value, /purpose|request|phase/u);
  });

  it.each([
    { purpose: "journal-tombstone", id: UUID.toUpperCase() },
    { purpose: "manifest-generation", id: "A".repeat(64) },
    { purpose: "manifest-generation", id: "a".repeat(63) },
    { purpose: "manifest-temporary", id: "not-a-uuid" },
    { purpose: "current-temporary", id: "123e4567-e89b-12d3-a456-426614174000" },
    { purpose: "inventory-work", id: "123e4567-e89b-42d3-c456-426614174000" },
    { purpose: "payload", id: "copy-001" },
    { purpose: "payload", id: "generated-dist" },
    { purpose: "rollback", id: UUID },
    { purpose: "conflict", id: RESTORE_ID },
    { purpose: "divergent-diff", id: "generated-next" },
    { purpose: "inventory", phase: "pre", id: RESTORE_ID },
    { purpose: "inventory", phase: "restore-active", id: "copy-0001" },
  ])("enforces purpose-specific ID grammar: %o", (pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "derive-error", pathRequest }));
    expectCapturedError(value, /ID|identifier|request/u);
  });

  it.each([
    { purpose: "payload", id: "copy-0000" },
    { purpose: "conflict", id: "copy-0000" },
    { purpose: "divergent-diff", id: "copy-0000" },
    { purpose: "inventory", phase: "pre", id: "copy-0000" },
    { purpose: "inventory", phase: "moved-pass-1", id: "copy-0000" },
    { purpose: "inventory", phase: "moved-pass-2", id: "copy-0000" },
  ])("rejects the reserved zero copy ID: %o", (pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "derive-error", pathRequest }));
    expectCapturedError(value, /ID|identifier|request/u);
  });

  it.each(["../escape", ".", "..", "-leading", "trailing-", "Cafe\u0301"])(
    "rejects unsafe transaction ID: %s",
    (transactionId) => {
      const result = invoke(fixture, { operation: "open", transactionId });
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/transaction/u) },
      });
    },
  );

  it("rejects quarantine inside the repository", () => {
    const quarantineRoot = join(fixture.repoRoot, "quarantine");
    privateDirectory(quarantineRoot);
    privateDirectory(join(quarantineRoot, TRANSACTION_ID));
    const result = invoke(
      { ...fixture, quarantineRoot, runRoot: join(quarantineRoot, TRANSACTION_ID) },
      { operation: "open" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/outside|repository/u) },
    });
  });

  it("rejects symlink quarantine and run roots", () => {
    const realQuarantine = join(fixture.base, "real-quarantine");
    privateDirectory(realQuarantine);
    privateDirectory(join(realQuarantine, TRANSACTION_ID));
    const quarantineLink = join(fixture.base, "quarantine-link");
    symlinkSync(realQuarantine, quarantineLink);
    expect(
      invoke({ ...fixture, quarantineRoot: quarantineLink }, { operation: "open" }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/symlink/u) } });

    const realRunRoot = join(fixture.base, "real-run");
    privateDirectory(realRunRoot);
    symlinkSync(realRunRoot, join(fixture.quarantineRoot, "linked-run"));
    expect(
      invoke(fixture, { operation: "open", transactionId: "linked-run" }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/symlink/u) } });
  });

  it.each(["quarantine", "run"])("rejects non-0700 %s root mode", (target) => {
    chmodSync(target === "quarantine" ? fixture.quarantineRoot : fixture.runRoot, 0o755);
    expect(invoke(fixture, { operation: "open" })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/0700|mode/u) },
    });
  });

  it("rejects repository/quarantine device mismatch", () => {
    expect(invoke(fixture, { operation: "device-mismatch" })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/device/u) },
    });
  });

  it.each(["quarantine", "run"])("rejects %s root inode replacement", (target) => {
    const value = workerValue(invoke(fixture, { operation: "replace-root", target }));
    expectCapturedError(value.derive, /identity|inode/u);
    expectCapturedError(value.revalidate, /identity|inode/u);
  });

  it.each([
    ["journal", { purpose: "journal" }, ""],
    ["inventory", { purpose: "inventory", phase: "pre", id: "copy-0001" }, "inventories/pre"],
    ["manifest", { purpose: "manifest-generation", id: DIGEST }, "manifests"],
  ] as const)(
    "rejects symlink replacement of derived %s parent without touching its target",
    (_label, pathRequest, parentRelativePath) => {
      const external = join(fixture.base, "external");
      privateDirectory(external);
      const sentinel = join(external, "sentinel.txt");
      writeFileSync(sentinel, "unchanged");
      const value = workerValue(
        invoke(fixture, { operation: "replace-parent", pathRequest, external }),
      );
      expect(value.parent).toBe(
        parentRelativePath === "" ? fixture.runRoot : join(fixture.runRoot, parentRelativePath),
      );
      expectCapturedError(value.derive, /symlink|identity/u);
      expectCapturedError(value.before, /symlink|identity/u);
      expectCapturedError(value.after, /symlink|identity/u);
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    },
  );

  it("rejects non-0700 selected parent at derivation and both boundaries", () => {
    const value = workerValue(
      invoke(fixture, {
        operation: "parent-mode",
        pathRequest: { purpose: "manifest-generation", id: DIGEST },
      }),
    );
    expectCapturedError(value.derive, /0700|mode/u);
    expectCapturedError(value.before, /0700|mode/u);
    expectCapturedError(value.after, /0700|mode/u);
  });
});
