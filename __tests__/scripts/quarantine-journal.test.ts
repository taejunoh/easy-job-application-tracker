import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const journalModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-journal.mjs"),
).href;
const manifestModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-manifest.mjs"),
).href;

function invokeJournal(request: Record<string, unknown>) {
  const source = `
import * as journal from ${JSON.stringify(journalModuleUrl)};
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const durabilityEvents = [];
const wrappedFs = request.trackDurability ? {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") return async () => {
          durabilityEvents.push(path === dirname(request.journalPath) ? "directory-sync" : "file-sync");
          return target.sync();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
} : undefined;
try {
  let result;
  if (request.operation === "append-many") {
    result = [];
    for (const record of request.records) {
      result.push(await journal.appendJournalRecord({
        journalPath: request.journalPath,
        event: record.event,
        payload: record.payload,
        ...(wrappedFs ? { fsApi: wrappedFs } : {}),
      }));
    }
  } else if (request.operation === "replay") {
    result = await journal.replayJournal(request.journalPath);
  } else if (request.operation === "transition") {
    result = journal.validateTransition(request.state, request.event);
  }
  process.stdout.write(JSON.stringify({ ok: true, result, durabilityEvents }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, durabilityEvents }));
}
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify(request),
    }),
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}

const happyRecords = [
  { event: "PREPARED", payload: { transactionId: "tx-0001" } },
  { event: "MOVING", payload: {} },
  { event: "MOVE_INTENT", payload: { id: "copy-0001" } },
  { event: "MOVED", payload: { id: "copy-0001" } },
  { event: "VERIFYING", payload: {} },
  { event: "QUARANTINED", payload: {} },
] as const;

function appendMany(journalPath: string, records = happyRecords, trackDurability = false) {
  return invokeJournal({ operation: "append-many", journalPath, records, trackDurability });
}

function replay(journalPath: string) {
  return invokeJournal({ operation: "replay", journalPath }).result;
}

function rawFrames(path: string) {
  const input = readFileSync(path);
  const frames: Array<{ start: number; length: number; body: Buffer }> = [];
  let offset = 0;
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    frames.push({ start: offset, length, body: input.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return { input, frames };
}

describe("durable quarantine journal", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-journal-"));

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it("appends exact hash-chained envelopes and replays lifecycle state", () => {
    const path = join(fixture, "happy", "journal.log");
    appendMany(path);

    const replayed = replay(path);
    expect(replayed.state).toBe("QUARANTINED");
    expect(replayed.records).toHaveLength(happyRecords.length);
    expect(Object.keys(replayed.records[0])).toEqual([
      "sequence",
      "previousHash",
      "event",
      "payload",
      "recordHash",
    ]);
    expect(replayed.records[0]).toMatchObject({
      sequence: 1,
      previousHash: "0".repeat(64),
      event: "PREPARED",
      payload: { transactionId: "tx-0001" },
    });
    expect(replayed.records[1].previousHash).toBe(replayed.records[0].recordHash);
    expect(replayed.records.every((record: { recordHash: string }) =>
      /^[a-f0-9]{64}$/u.test(record.recordHash),
    )).toBe(true);
  });

  it("writes a 0600 length-framed journal and syncs the file before its parent directory", () => {
    const path = join(fixture, "durability", "journal.log");
    const appended = appendMany(path, happyRecords.slice(0, 1), true);
    expect(readFileSync(path).readUInt32BE(0)).toBe(rawFrames(path).frames[0].body.length);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(appended.durabilityEvents).toEqual(["file-sync", "directory-sync"]);

    chmodSync(path, 0o666);
    appendMany(path, [{ event: "MOVING", payload: {} }]);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    [null, "PREPARED", "PREPARED"],
    ["PREPARED", "MOVING", "MOVING"],
    ["MOVING", "MOVE_INTENT", "MOVING"],
    ["MOVING", "MOVED", "MOVING"],
    ["MOVING", "VERIFYING", "VERIFYING"],
    ["VERIFYING", "QUARANTINED", "QUARANTINED"],
    ["QUARANTINED", "VALIDATED", "VALIDATED"],
    ["MOVING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["VERIFYING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["RECOVERY_REQUIRED", "ROLLING_BACK", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLBACK_INTENT", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLED_BACK_ENTRY", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLED_BACK", "ROLLED_BACK"],
    ["MOVING", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["QUARANTINED", "RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["VALIDATED", "RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["RESTORE_PREPARED", "RESTORING", "RESTORING"],
    ["RESTORING", "RESTORE_INTENT", "RESTORING"],
    ["RESTORING", "RESTORED_ENTRY", "RESTORING"],
    ["RESTORING", "RESTORED", "RESTORED"],
  ])("validates transition %s -> %s", (state, event, expected) => {
    expect(invokeJournal({ operation: "transition", state, event }).result).toBe(expected);
  });

  it.each([
    [null, "MOVING"],
    ["PREPARED", "QUARANTINED"],
    ["MOVING", "VALIDATED"],
    ["INCOMPLETE_CONFLICT", "ROLLING_BACK"],
    ["ROLLED_BACK", "MOVING"],
    ["RESTORED", "RESTORING"],
    ["QUARANTINED", "MOVED"],
  ])("fails closed for illegal transition %s -> %s", (state, event) => {
    expect(() => invokeJournal({ operation: "transition", state, event })).toThrow(
      /transition/u,
    );
  });

  it("keeps MOVE_INTENT authoritative across all pre-MOVED interruption boundaries", () => {
    const path = join(fixture, "boundaries", "journal.log");
    appendMany(path, happyRecords.slice(0, 3));
    const intentBytes = readFileSync(path);

    for (const boundary of [
      "payload rename",
      "payload fsync",
      "source-parent fsync",
      "destination-parent fsync",
      "verification",
    ]) {
      writeFileSync(path, intentBytes);
      expect(replay(path).records.at(-1)).toMatchObject({ event: "MOVE_INTENT" });
      expect(boundary).toBeTruthy();
    }

    appendMany(path, [{ event: "MOVED", payload: { id: "copy-0001" } }]);
    expect(replay(path).records.at(-1)).toMatchObject({ event: "MOVED" });
  });

  it("ignores only a torn final length or body", () => {
    const path = join(fixture, "torn", "journal.log");
    appendMany(path, happyRecords.slice(0, 2));
    const intact = readFileSync(path);

    appendFileSync(path, Buffer.from([0, 1]));
    expect(replay(path).records).toHaveLength(2);

    writeFileSync(path, intact);
    const finalFrame = rawFrames(path).frames.at(-1)!;
    const torn = Buffer.concat([
      intact,
      Buffer.from([0, 0, 0, finalFrame.length]),
      finalFrame.body.subarray(0, Math.floor(finalFrame.length / 2)),
    ]);
    writeFileSync(path, torn);
    expect(replay(path).records).toHaveLength(2);
  });

  it("fails closed for a malformed complete middle frame", () => {
    const path = join(fixture, "malformed", "journal.log");
    appendMany(path, happyRecords.slice(0, 3));
    const { input, frames } = rawFrames(path);
    input[frames[1].start + 4] = 0xff;
    writeFileSync(path, input);
    expect(() => replay(path)).toThrow(/malformed/u);
  });

  it.each([
    ["changed payload", (record: Record<string, unknown>) => {
      (record.payload as Record<string, unknown>).transactionId = "tx-0002";
    }, /hash/u],
    ["unknown key", (record: Record<string, unknown>) => {
      record.attackerPath = "../victim";
    }, /unknown field/u],
    ["sequence gap", (record: Record<string, unknown>) => {
      record.sequence = 9;
    }, /sequence/u],
    ["hash mismatch", (record: Record<string, unknown>) => {
      record.recordHash = "f".repeat(64);
    }, /hash/u],
  ])("rejects %s", (_label, mutate, expected) => {
    const path = join(fixture, `tamper-${String(_label).replaceAll(" ", "-")}`, "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const { frames } = rawFrames(path);
    const record = JSON.parse(frames[0].body.toString("utf8"));
    mutate(record);
    const body = Buffer.from(JSON.stringify(record));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    writeFileSync(path, Buffer.concat([length, body]));
    expect(() => replay(path)).toThrow(expected);
  });
});

function manifestValue(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    transactionId: "2026-07-14T12-00-00.000Z",
    state: "QUARANTINED",
    repositoryRoot: "/repo/easy-job-application-tracker",
    head: "a".repeat(40),
    createdAt: "2026-07-14T12:00:00.000Z",
    validatedAt: null,
    retentionDays: null,
    deletionRequiresConfirmation: true,
    deleteAfter: null,
    deletionStatus: "retained",
    entries: [],
    ...overrides,
  };
}

function invokeManifest(request: Record<string, unknown>) {
  const source = `
import * as manifest from ${JSON.stringify(manifestModuleUrl)};
import * as fsPromises from "node:fs/promises";
import { basename } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const durabilityEvents = [];
const wrappedFs = request.trackDurability ? {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") return async () => {
          durabilityEvents.push("sync:" + basename(path));
          return target.sync();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
  rename: async (source, destination) => {
    durabilityEvents.push("rename:" + basename(source) + "->" + basename(destination));
    return fsPromises.rename(source, destination);
  },
} : undefined;
try {
  const fsApi = wrappedFs ?? fsPromises;
  let result;
  if (request.operation === "publish") {
    result = await manifest.publishManifest({
      quarantineRoot: request.quarantineRoot,
      manifest: request.manifest,
      fsApi,
    });
  } else if (request.operation === "read") {
    result = await manifest.readManifest({ quarantineRoot: request.quarantineRoot, fsApi });
  } else if (request.operation === "mark") {
    result = await manifest.markQuarantineValidated({
      quarantineRoot: request.quarantineRoot,
      now: request.now,
      fsApi,
    });
  }
  process.stdout.write(JSON.stringify({ ok: true, result, durabilityEvents }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, durabilityEvents }));
}
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify(request),
    }),
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("small quarantine manifest publisher", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-manifest-"));

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it("rejects unknown manifest fields", () => {
    const quarantineRoot = join(fixture, "unknown-field");
    expect(() =>
      invokeManifest({
        operation: "publish",
        quarantineRoot,
        manifest: { ...manifestValue(), attackerPath: "../victim" },
      }),
    ).toThrow(/unknown field/u);
  });

  it("publishes through atomic temp replacements with file-before-directory fsync", () => {
    const quarantineRoot = join(fixture, "publish");
    const manifest = manifestValue();
    const published = invokeManifest({
      operation: "publish",
      quarantineRoot,
      manifest,
      trackDurability: true,
    });
    const runRoot = join(quarantineRoot, manifest.transactionId);

    expect(invokeManifest({ operation: "read", quarantineRoot }).result).toEqual(manifest);
    expect(readFileSync(join(quarantineRoot, "current"), "utf8")).toBe(
      `${manifest.transactionId}\n`,
    );
    for (const path of [
      join(runRoot, "manifest.json"),
      join(runRoot, "manifest.sha256"),
      join(quarantineRoot, "current"),
    ]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }

    const renames = published.durabilityEvents
      .map((event: string, index: number) => ({ event, index }))
      .filter(({ event }: { event: string }) => event.startsWith("rename:"));
    expect(renames).toHaveLength(3);
    for (const { event, index } of renames) {
      const [temporaryName, targetName] = event.slice("rename:".length).split("->");
      expect(temporaryName).toContain(".tmp-");
      expect(["manifest.json", "manifest.sha256", "current"]).toContain(targetName);
      expect(published.durabilityEvents[index - 1]).toBe(`sync:${temporaryName}`);
      expect(published.durabilityEvents[index + 1]).toMatch(/^sync:/u);
    }
    expect(renames.at(-1)!.event.endsWith("->current")).toBe(true);
  });

  it("rejects a path-bearing current pointer before deriving a run path", () => {
    const quarantineRoot = join(fixture, "pointer");
    invokeManifest({ operation: "publish", quarantineRoot, manifest: manifestValue() });
    writeFileSync(join(quarantineRoot, "current"), "../victim\n", { mode: 0o600 });
    expect(() => invokeManifest({ operation: "read", quarantineRoot })).toThrow(
      /transaction ID/u,
    );
  });

  it("marks validation with an exact four-day retention deadline and persists it", () => {
    const quarantineRoot = join(fixture, "validated");
    invokeManifest({ operation: "publish", quarantineRoot, manifest: manifestValue() });
    const marked = invokeManifest({
      operation: "mark",
      quarantineRoot,
      now: "2026-07-14T12:00:00.000Z",
    }).result;

    expect(marked).toMatchObject({
      state: "VALIDATED",
      validatedAt: "2026-07-14T12:00:00.000Z",
      retentionDays: 4,
      deletionRequiresConfirmation: true,
      deleteAfter: "2026-07-18T12:00:00.000Z",
    });
    expect(invokeManifest({ operation: "read", quarantineRoot }).result).toEqual(marked);
  });

  it("refuses to mark a manifest that is not quarantined", () => {
    const quarantineRoot = join(fixture, "wrong-state");
    invokeManifest({
      operation: "publish",
      quarantineRoot,
      manifest: manifestValue({ state: "PREPARED" }),
    });
    expect(() =>
      invokeManifest({
        operation: "mark",
        quarantineRoot,
        now: "2026-07-14T12:00:00.000Z",
      }),
    ).toThrow(/QUARANTINED/u);
  });
});
