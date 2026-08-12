import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalDiff,
  createQuarantineFixture,
  FS_METHODS,
  git,
  HISTORY_FRAME_LIMIT,
  HISTORY_OID_BODY_LIMIT,
  installGitDiffOverride,
  installGitOutputOverride,
  invokeQuarantineWorker,
  invokeWithGitStdoutError,
  LAYOUT_RELATIVES,
  listLockResidue,
  privateDirectory,
  STATUS_RECORD_LIMIT,
  type ValueShape,
  type WorkerResult,
} from "../fixtures/quarantine/quarantine-test-harness";
function expectWorkerError(result: WorkerResult, code: string, message: string) {
  expect(result.ok).toBe(false);
  expect(result.error!).toMatchObject({
    instanceOfError: true,
    name: "QuarantineError",
    code,
    message,
    symbolCount: 0,
    enumerableKeys: [],
    json: "{}",
    frozen: true,
    extensible: false,
    prototypeIsError: false,
    prototypeParentIsError: true,
    prototypeOwnKeys: ["constructor"],
    codeMutationInert: true,
  });
  expect(new Set(result.error!.ownKeys)).toEqual(new Set(["stack", "message", "name", "code"]));
  for (const descriptor of Object.values(result.error!.descriptors)) {
    expect(descriptor).toMatchObject({ enumerable: false, configurable: false, writable: false });
  }
}

function journalRecords(path: string) {
  const bytes = readFileSync(path);
  const records = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    records.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  return records;
}

function rewriteJournal(path: string, records: Array<{ event: string; payload: unknown }>) {
  let previousHash = "0".repeat(64);
  const frames = records.map((record, index) => {
    const sequence = index + 1;
    const recordHash = createHash("sha256")
      .update(JSON.stringify({ sequence, previousHash, event: record.event, payload: record.payload }))
      .digest("hex");
    const body = Buffer.from(JSON.stringify({
      sequence,
      previousHash,
      event: record.event,
      payload: record.payload,
      recordHash,
    }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    previousHash = recordHash;
    return Buffer.concat([length, body]);
  });
  writeFileSync(path, Buffer.concat(frames));
}

describe("quarantine transaction Slice 1", () => {
  it("exports explicit semantic apply recovery", () => {
    const result = invokeQuarantineWorker("exports", {});

    expect(result).toMatchObject({ ok: true });
    expect(result.exports).toContain("recoverQuarantine");
  });

  it("resumes a durable move intent left before its rename", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId: "tx-recover-intent",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: "after-event:MOVE_INTENT:copy-0001",
    }).ok).toBe(false);

    const recovered = invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId: request.transactionId,
      action: "resume",
      writersStopped: true,
    });

    expect(recovered).toMatchObject({
      ok: true,
      result: {
        transactionId: request.transactionId,
        status: "QUARANTINED",
        action: "resume",
      },
    });
    expect(recovered.replayEvents?.map((record) => record.event)).toEqual(expect.arrayContaining([
      "RECOVERY_REQUIRED", "MOVED", "VERIFYING", "QUARANTINED",
    ]));
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(false);
    expect(existsSync(join(f.quarantineRoot, request.transactionId,
      "payload/source-copies/copy-0001"))).toBe(true);
  });

  it.each([
    ["source-present-payload-absent", "resume", "QUARANTINED"],
    ["source-present-payload-absent", "rollback", "ROLLED_BACK"],
    ["source-absent-matching-payload", "resume", "QUARANTINED"],
    ["source-absent-matching-payload", "rollback", "ROLLED_BACK"],
    ["both-present", "resume", "INCOMPLETE_CONFLICT"],
    ["both-present", "rollback", "INCOMPLETE_CONFLICT"],
    ["both-absent", "resume", "INCOMPLETE_CONFLICT"],
    ["both-absent", "rollback", "INCOMPLETE_CONFLICT"],
    ["source-absent-mismatching-payload", "resume", "INCOMPLETE_CONFLICT"],
    ["source-absent-mismatching-payload", "rollback", "INCOMPLETE_CONFLICT"],
    ["source-mismatching-payload-absent", "resume", "INCOMPLETE_CONFLICT"],
    ["source-mismatching-payload-absent", "rollback", "INCOMPLETE_CONFLICT"],
    ["both-present-with-mismatch", "resume", "INCOMPLETE_CONFLICT"],
    ["both-present-with-mismatch", "rollback", "INCOMPLETE_CONFLICT"],
  ] as const)("reconciles %s evidence with %s", (scenario, action, expectedStatus) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = `tx-recovery-${scenario}-${action}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const afterRename = scenario === "source-absent-matching-payload" ||
      scenario === "both-present" ||
      scenario === "source-absent-mismatching-payload";
    expect(invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: afterRename ? "after-rename:copy-0001" : "after-event:MOVE_INTENT:copy-0001",
    }).ok).toBe(false);

    const source = join(f.repoRoot, "notes 2.txt");
    const payload = join(f.quarantineRoot, transactionId, "payload/source-copies/copy-0001");
    if (scenario === "both-present") writeFileSync(source, "canonical\n");
    if (scenario === "both-absent") rmSync(source);
    if (scenario === "source-absent-mismatching-payload") writeFileSync(payload, "payload mismatch\n");
    if (scenario === "source-mismatching-payload-absent") writeFileSync(source, "source mismatch\n");
    if (scenario === "both-present-with-mismatch") {
      writeFileSync(source, "source mismatch\n");
      writeFileSync(payload, "payload mismatch\n");
    }
    const before = [source, payload].filter(existsSync).map((path) => [path, readFileSync(path)] as const);

    const recovered = invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action,
      writersStopped: true,
    });

    expect(recovered.ok).toBe(true);
    expect(recovered.result).toMatchObject({ transactionId, action, status: expectedStatus });
    if (expectedStatus === "INCOMPLETE_CONFLICT") {
      expect(recovered.result).toEqual({
        transactionId,
        status: "INCOMPLETE_CONFLICT",
        action,
        conflictEntryIds: ["copy-0001"],
      });
      for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
    } else {
      expect(Object.keys(recovered.result!)).toEqual([
        "transactionId", "status", "action", "reconciledEntries",
      ]);
    }
  });

  it.each([
    ["after-event:PREPARED", "resume", "QUARANTINED"],
    ["after-event:PREPARED", "rollback", "ROLLED_BACK"],
    ["after-event:MOVING", "resume", "QUARANTINED"],
    ["after-event:MOVING", "rollback", "ROLLED_BACK"],
  ] as const)("recovers a %s crash with no durable intent by %s", (stopPhase, action, status) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-no-intent";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const stopped = invokeQuarantineWorker("apply-stop", { ...request, stopPhase });
    expect(stopped.ok).toBe(false);
    expect(stopped.phases).toContain(stopPhase);
    expect(invokeQuarantineWorker("replay-run", request).result?.state).toBe(
      stopPhase === "after-event:PREPARED" ? "PREPARED" : "MOVING",
    );

    const recovered = invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action,
      writersStopped: true,
    });

    expect(recovered).toMatchObject({ ok: true });
    expect(recovered.result).toMatchObject({ transactionId, status, action });
    expect(recovered.replayEvents?.find((event) => event.event === "RECOVERY_REQUIRED"))
      .toEqual({ event: "RECOVERY_REQUIRED", payload: { entryIds: [] } });
  });

  it("resumes an all-completed apply ledger without moving evidence again", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-recover-all-completed";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: "after-event:VERIFYING",
    }).ok).toBe(false);
    const payload = join(f.quarantineRoot, transactionId, "payload/source-copies/copy-0001");
    const before = readFileSync(payload);

    const recovered = invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action: "resume",
      writersStopped: true,
    });

    expect(recovered.result).toEqual({
      transactionId,
      status: "QUARANTINED",
      action: "resume",
      reconciledEntries: 0,
    });
    expect(readFileSync(payload)).toEqual(before);
    const recovery = recovered.replayEvents?.find((event) => event.event === "RECOVERY_REQUIRED");
    expect(recovery?.payload.entryIds).toEqual([
      "generated-next", "generated-node-modules", "copy-0001",
    ]);
  });

  it("makes QUARANTINED resume idempotent and directs rollback to restore", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-recover-terminal";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply", request)).toMatchObject({ ok: true });
    const before = invokeQuarantineWorker("replay-run", request).result;

    expect(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action: "resume",
      writersStopped: true,
    }).result).toEqual({
      transactionId,
      status: "QUARANTINED",
      action: "resume",
      reconciledEntries: 0,
    });
    expect(invokeQuarantineWorker("replay-run", request).result).toEqual(before);
    expectWorkerError(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action: "rollback",
      writersStopped: true,
    }), "ERR_USAGE", "Invalid quarantine request.");
  });

  it.each(["QUARANTINED", "VALIDATED"] as const)(
    "rejects a rehashed partial manifest ledger before returning terminal %s",
    (terminal) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = `tx-partial-terminal-${terminal.toLowerCase()}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: f.expectedCount,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      expect(invokeQuarantineWorker("apply", request)).toMatchObject({ ok: true });
      const journal = join(f.quarantineRoot, transactionId, "journal.log");
      const original = journalRecords(journal);
      const partial = [
        original.find((record) => record.event === "PREPARED")!,
        original.find((record) => record.event === "MOVING")!,
        original.find((record) => record.event === "MOVE_INTENT")!,
        original.find((record) => record.event === "MOVED")!,
        original.find((record) => record.event === "VERIFYING")!,
        original.find((record) => record.event === "QUARANTINED")!,
      ];
      if (terminal === "VALIDATED") {
        const prepared = partial[0];
        partial.push({
          event: "VALIDATED",
          payload: { manifestSha256: prepared.payload.manifestSha256 },
        });
      }
      rewriteJournal(journal, partial);
      const beforeJournal = readFileSync(journal);
      const payload = join(f.quarantineRoot, transactionId, "payload/source-copies/copy-0001");
      const beforePayload = readFileSync(payload);

      expectWorkerError(invokeQuarantineWorker("recover", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        transactionId,
        action: "resume",
        writersStopped: true,
      }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
      expect(readFileSync(journal)).toEqual(beforeJournal);
      expect(readFileSync(payload)).toEqual(beforePayload);
    },
  );

  it("rejects a rehashed VALIDATED record whose digest differs from PREPARED", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-terminal-validated-digest";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply", request)).toMatchObject({ ok: true });
    const journal = join(f.quarantineRoot, transactionId, "journal.log");
    const records = journalRecords(journal);
    rewriteJournal(journal, [...records, {
      event: "VALIDATED",
      payload: { manifestSha256: "b".repeat(64) },
    }]);
    const beforeJournal = readFileSync(journal);

    expectWorkerError(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action: "resume",
      writersStopped: true,
    }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
    expect(readFileSync(journal)).toEqual(beforeJournal);
  });

  it.each([
    ["VALIDATED", "rollback"],
    ["ROLLED_BACK", "resume"],
  ] as const)("rejects unsupported intact terminal %s %s without mutation", (terminal, action) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = `tx-terminal-action-${terminal.toLowerCase()}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    if (terminal === "VALIDATED") {
      expect(invokeQuarantineWorker("apply", request)).toMatchObject({ ok: true });
      const journal = join(f.quarantineRoot, transactionId, "journal.log");
      const records = journalRecords(journal);
      rewriteJournal(journal, [...records, {
        event: "VALIDATED",
        payload: { manifestSha256: records[0].payload.manifestSha256 },
      }]);
    } else {
      expect(invokeQuarantineWorker("apply-stop", {
        ...request,
        stopPhase: "after-event:MOVE_INTENT:copy-0001",
      }).ok).toBe(false);
      expect(invokeQuarantineWorker("recover", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        transactionId,
        action: "rollback",
        writersStopped: true,
      }).result).toMatchObject({ status: "ROLLED_BACK" });
    }
    const runRoot = join(f.quarantineRoot, transactionId);
    const journal = join(runRoot, "journal.log");
    const beforeJournal = readFileSync(journal);
    const evidence = [
      join(f.repoRoot, "notes 2.txt"),
      join(runRoot, "payload/source-copies/copy-0001"),
    ].filter(existsSync).map((path) => [path, readFileSync(path)] as const);

    expectWorkerError(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action,
      writersStopped: true,
    }), "ERR_USAGE", "Invalid quarantine request.");
    expect(readFileSync(journal)).toEqual(beforeJournal);
    for (const [path, bytes] of evidence) expect(readFileSync(path)).toEqual(bytes);
  });

  it("validates terminal manifest evidence before returning VALIDATED resume", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-recover-validated";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply", request)).toMatchObject({ ok: true });
    const runRoot = join(f.quarantineRoot, transactionId);
    const journal = join(runRoot, "journal.log");
    const journalBytes = readFileSync(journal);
    const firstSize = journalBytes.readUInt32BE(0);
    const prepared = JSON.parse(journalBytes.subarray(4, 4 + firstSize).toString("utf8"));
    let offset = 0;
    let previousHash = "0".repeat(64);
    let sequence = 0;
    while (offset < journalBytes.length) {
      const size = journalBytes.readUInt32BE(offset);
      const record = JSON.parse(journalBytes.subarray(offset + 4, offset + 4 + size).toString("utf8"));
      previousHash = record.recordHash;
      sequence = record.sequence;
      offset += 4 + size;
    }
    const payload = { manifestSha256: prepared.payload.manifestSha256 };
    const recordHash = createHash("sha256")
      .update(JSON.stringify({ sequence: sequence + 1, previousHash, event: "VALIDATED", payload }))
      .digest("hex");
    const body = Buffer.from(JSON.stringify({
      sequence: sequence + 1,
      previousHash,
      event: "VALIDATED",
      payload,
      recordHash,
    }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    appendFileSync(journal, Buffer.concat([length, body]));
    expect(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action: "resume",
      writersStopped: true,
    }).result).toEqual({
      transactionId,
      status: "VALIDATED",
      action: "resume",
      reconciledEntries: 0,
    });

    const manifest = join(runRoot, "manifests", `${prepared.payload.manifestSha256}.json`);
    rmSync(manifest);
    const beforeJournal = readFileSync(journal);
    const payloadPath = join(runRoot, "payload/source-copies/copy-0001");
    const beforePayload = readFileSync(payloadPath);
    expectWorkerError(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action: "resume",
      writersStopped: true,
    }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
    expect(readFileSync(journal)).toEqual(beforeJournal);
    expect(readFileSync(payloadPath)).toEqual(beforePayload);
  });

  it.each([
    ["ROLLED_BACK", "missing"],
    ["ROLLED_BACK", "corrupt"],
    ["INCOMPLETE_CONFLICT", "missing"],
    ["INCOMPLETE_CONFLICT", "corrupt"],
  ] as const)(
    "rejects %s terminal manifest before returning %s",
    (terminal, manifestVariant) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = `tx-recover-terminal-${terminal.toLowerCase()}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: f.expectedCount,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      expect(invokeQuarantineWorker("apply-stop", {
        ...request,
        stopPhase: "after-event:MOVE_INTENT:copy-0001",
      }).ok).toBe(false);
      const runRoot = join(f.quarantineRoot, transactionId);
      const source = join(f.repoRoot, "notes 2.txt");
      const payloadPath = join(runRoot, "payload/source-copies/copy-0001");
      if (terminal === "ROLLED_BACK") {
        expect(invokeQuarantineWorker("recover", {
          repoRoot: f.repoRoot,
          quarantineRoot: f.quarantineRoot,
          transactionId,
          action: "rollback",
          writersStopped: true,
        }).result).toEqual({
          transactionId,
          status: "ROLLED_BACK",
          action: "rollback",
          reconciledEntries: 2,
        });
      } else {
        writeFileSync(payloadPath, "foreign payload\n");
        expect(invokeQuarantineWorker("recover", {
          repoRoot: f.repoRoot,
          quarantineRoot: f.quarantineRoot,
          transactionId,
          action: "resume",
          writersStopped: true,
        }).result).toEqual({
          transactionId,
          status: "INCOMPLETE_CONFLICT",
          action: "resume",
          conflictEntryIds: ["copy-0001"],
        });
      }
      const journal = join(runRoot, "journal.log");
      const journalBytes = readFileSync(journal);
      const firstSize = journalBytes.readUInt32BE(0);
      const prepared = JSON.parse(journalBytes.subarray(4, 4 + firstSize).toString("utf8"));
      const manifest = join(runRoot, "manifests", `${prepared.payload.manifestSha256}.json`);
      if (manifestVariant === "missing") rmSync(manifest);
      else writeFileSync(manifest, "corrupt terminal manifest\n");
      const beforeJournal = readFileSync(journal);
      const beforeManifest = manifestVariant === "missing" ? null : readFileSync(manifest);
      const beforeEvidence = [source, payloadPath].filter(existsSync)
        .map((path) => [path, readFileSync(path)] as const);
      expectWorkerError(invokeQuarantineWorker("recover", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        transactionId,
        action: terminal === "ROLLED_BACK" ? "rollback" : "resume",
        writersStopped: true,
      }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
      expect(readFileSync(journal)).toEqual(beforeJournal);
      if (beforeManifest !== null) expect(readFileSync(manifest)).toEqual(beforeManifest);
      for (const [path, bytes] of beforeEvidence) expect(readFileSync(path)).toEqual(bytes);
    },
  );

  it.each(["torn-frame", "wrong-record-digest", "stale-lock", "missing-manifest"] as const)(
    "rejects %s recovery evidence before any recovery mutation",
    (variant) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = "tx-recovery-integrity";
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: f.expectedCount,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      expect(invokeQuarantineWorker("apply-stop", {
        ...request,
        stopPhase: "after-event:MOVE_INTENT:copy-0001",
      }).ok).toBe(false);
      const runRoot = join(f.quarantineRoot, transactionId);
      const journal = join(runRoot, "journal.log");
      const source = join(f.repoRoot, "notes 2.txt");
      if (variant === "torn-frame") appendFileSync(journal, Buffer.from([0, 0]));
      if (variant === "wrong-record-digest") {
        const bytes = readFileSync(journal);
        const size = bytes.readUInt32BE(0);
        const first = JSON.parse(bytes.subarray(4, 4 + size).toString("utf8"));
        first.recordHash = "f".repeat(64);
        const body = Buffer.from(JSON.stringify(first));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length);
        writeFileSync(journal, Buffer.concat([length, body, bytes.subarray(4 + size)]));
      }
      if (variant === "stale-lock") writeFileSync(join(runRoot, "journal.lock"), "foreign");
      if (variant === "missing-manifest") {
        const name = readdirSync(join(runRoot, "manifests"))[0];
        rmSync(join(runRoot, "manifests", name));
      }
      const beforeJournal = readFileSync(journal);
      const beforeSource = readFileSync(source);

      expectWorkerError(invokeQuarantineWorker("recover", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        transactionId,
        action: "resume",
        writersStopped: true,
      }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
      expect(readFileSync(journal)).toEqual(beforeJournal);
      expect(readFileSync(source)).toEqual(beforeSource);
      expect(existsSync(join(runRoot, "payload/source-copies/copy-0001"))).toBe(false);
      if (variant === "stale-lock") {
        expect(readFileSync(join(runRoot, "journal.lock"))).toEqual(Buffer.from("foreign"));
      }
    },
  );

  it.each(["getter", "receiver", "method"] as const)(
    "keeps the captured supplied filesystem authority after %s mutation",
    (fsMutation) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = `tx-captured-source-${fsMutation}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: f.expectedCount,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      expect(invokeQuarantineWorker("apply-stop", {
        ...request,
        stopPhase: "after-event:MOVE_INTENT:copy-0001",
      }).ok).toBe(false);

      const recovered = invokeQuarantineWorker("recover", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        transactionId,
        action: "resume",
        writersStopped: true,
        fsMutation,
      });

      expect(recovered.result).toMatchObject({ status: "QUARANTINED", action: "resume" });
      expect(recovered.wrongReceiver).toBe(0);
      expect(recovered.getterReads).toBe(fsMutation === "getter" ? 1 : 0);
    },
  );

  it.each([
    ["resume-source", "after-event:MOVE_INTENT:copy-0001", "resume", "MOVED"],
    ["rollback-payload", "after-rename:copy-0001", "rollback", "ROLLED_BACK_ENTRY"],
  ] as const)("does not rename foreign evidence injected at the %s journal seam", (
    race,
    stopPhase,
    action,
    completionEvent,
  ) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = `tx-rename-race-${action}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply-stop", { ...request, stopPhase }).ok).toBe(false);
    const runRoot = join(f.quarantineRoot, transactionId);
    const source = join(f.repoRoot, "notes 2.txt");
    const payload = join(runRoot, "payload/source-copies/copy-0001");

    expectWorkerError(invokeQuarantineWorker("recover", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      transactionId,
      action,
      writersStopped: true,
      race,
    }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
    if (race === "resume-source") {
      expect(readFileSync(source, "utf8")).toBe("foreign source\n");
      expect(existsSync(payload)).toBe(false);
    } else {
      expect(readFileSync(payload, "utf8")).toBe("foreign payload\n");
      expect(existsSync(source)).toBe(false);
    }
    const replay = invokeQuarantineWorker("replay-run", request).result!;
    expect(replay.records).not.toContainEqual(expect.objectContaining({
      event: completionEvent,
      payload: expect.objectContaining({ id: "copy-0001" }),
    }));
  });

  it("runs each rollback durability hook immediately after its corresponding sync", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-rollback-durability-order";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: f.expectedCount,
      transactionId,
      createdAt: "2026-07-17T00:00:05.000Z",
      writersStopped: true,
    };
    expect(invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: "after-rename:copy-0001",
    }).ok).toBe(false);

    const transactionUrl = pathToFileURL(
      join(__dirname, "../../scripts/quarantine-transaction.mjs"),
    ).href;
    const payload = join(f.quarantineRoot, transactionId, "payload/source-copies/copy-0001");
    const workspace = join(f.repoRoot, "notes 2.txt");
    const source = `
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";
import { recoverQuarantine } from ${JSON.stringify(transactionUrl)};
const request = ${JSON.stringify({
  repoRoot: f.repoRoot,
  quarantineRoot: f.quarantineRoot,
  transactionId,
  action: "rollback",
  writersStopped: true,
})};
const workspace = ${JSON.stringify(workspace)};
const payload = ${JSON.stringify(payload)};
const labels = new Map([
  [workspace, "payload"],
  [dirname(workspace), "destination-parent"],
  [dirname(payload), "source-parent"],
]);
const events = [];
let tracing = false;
const fsApi = {
  ...fsPromises,
  async open(path, ...args) {
    const handle = await fsPromises.open(path, ...args);
    const label = tracing && args[0] === "r" ? labels.get(path) : undefined;
    if (label === undefined) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") return async () => {
          const result = await target.sync();
          events.push("sync:" + label);
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
  createReadStream,
  lstatSync,
  realpathSync,
};
let failure;
try {
  await recoverQuarantine({
    ...request,
    fsApi,
    faultHook(phase) {
      if (phase === "after-rollback-rename:copy-0001") tracing = true;
      if (!phase.endsWith(":copy-0001")) return;
      if (phase.startsWith("after-rollback-")) events.push("hook:" + phase.slice(15, -10));
      if (phase === "after-rollback-source-parent-sync:copy-0001") throw new Error("stop trace");
    },
  });
} catch (error) {
  failure = error.message;
}
process.stdout.write(JSON.stringify({ failure, events }));
`;
    const traced = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
    });
    expect(traced.status).toBe(0);
    expect(JSON.parse(traced.stdout)).toEqual({
      failure: "Quarantine evidence failed integrity validation.",
      events: [
        "hook:rename",
        "sync:payload",
        "hook:payload-sync",
        "sync:destination-parent",
        "hook:destination-parent-sync",
        "sync:source-parent",
        "hook:source-parent-sync",
      ],
    });
  });

  const bases: string[] = [];

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  it("exposes the completed atomic apply and recovery API only at the Slice 2 surfaces", async () => {
    const exports = invokeQuarantineWorker("exports", {});
    expect(exports.exports).toEqual([
      "inspectWorkspace",
      "markQuarantineValidated",
      "quarantineWorkspace",
      "recoverQuarantine",
    ]);
    expect(exports.exports).not.toContain("withExistingQuarantineRun");
    expect(exports.runtimeExports).toEqual([
      "inspectWorkspace",
      "markQuarantineValidated",
      "prepareQuarantineWorkspace",
      "quarantineWorkspace",
      "recoverQuarantine",
    ]);
    expect(exports.legacyExports).not.toContain("prepareQuarantineWorkspace");
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    expect(Object.hasOwn(packageJson, "exports")).toBe(false);
  });

  it("returns QUARANTINED only after the complete durable atomic-move protocol", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-slice-2-happy",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const worker = invokeQuarantineWorker("apply", request, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toEqual({
      transactionId: "tx-slice-2-happy",
      status: "QUARANTINED",
      movedEntries: 3,
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      "after-event:MOVE_INTENT:generated-next",
      "after-rename:generated-next",
      "after-payload-sync:generated-next",
      "after-destination-parent-sync:generated-next",
      "after-source-parent-sync:generated-next",
      "after-inventory:moved-pass-1:generated-next",
      "after-event:MOVED:generated-next",
      "after-event:MOVE_INTENT:generated-node-modules",
      "after-rename:generated-node-modules",
      "after-payload-sync:generated-node-modules",
      "after-destination-parent-sync:generated-node-modules",
      "after-source-parent-sync:generated-node-modules",
      "after-inventory:moved-pass-1:generated-node-modules",
      "after-event:MOVED:generated-node-modules",
      "after-event:MOVE_INTENT:copy-0001",
      "after-rename:copy-0001",
      "after-payload-sync:copy-0001",
      "after-destination-parent-sync:copy-0001",
      "after-source-parent-sync:copy-0001",
      "after-inventory:moved-pass-1:copy-0001",
      "after-event:MOVED:copy-0001",
      "after-event:VERIFYING",
      "after-inventory:moved-pass-2:generated-next",
      "after-inventory:moved-pass-2:generated-node-modules",
      "after-inventory:moved-pass-2:copy-0001",
      "after-event:QUARANTINED",
      "before-lock-cleanup",
    ]);
    expect(existsSync(join(f.repoRoot, ".next"))).toBe(false);
    expect(existsSync(join(f.repoRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(false);
    expect(existsSync(join(f.quarantineRoot, "current"))).toBe(false);
    const runRoot = join(f.quarantineRoot, request.transactionId);
    const manifestSha256 = worker.result?.manifestSha256 as string;
    const manifestNames = readdirSync(join(runRoot, "manifests"));
    expect(manifestNames).toEqual([`${manifestSha256}.json`]);
    const manifestBytes = readFileSync(join(runRoot, "manifests", manifestNames[0]));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifestBytes).toEqual(Buffer.from(`${JSON.stringify(manifest)}\n`));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(manifestSha256);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      transactionId: request.transactionId,
      state: "PREPARED",
      retentionDays: 4,
      deletionRequiresConfirmation: true,
      deleteAfter: null,
      deletionStatus: "retained",
    });
    expect(manifest.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "generated-next", "generated-node-modules", "copy-0001",
    ]);
    const summaries = new Map(manifest.entries.map(
      (entry: { id: string; preMoveInventory: unknown }) => [entry.id, entry.preMoveInventory],
    ));
    const replay = invokeQuarantineWorker("replay-run", request, {}, 30_000);
    if (!replay.ok) throw new Error(JSON.stringify(replay.error));
    const replayed = replay.result as {
      state: string;
      records: Array<{ sequence: number; event: string; payload: Record<string, unknown> }>;
    };
    expect(replayed.state).toBe("QUARANTINED");
    expect(replayed.records).toEqual([
      { sequence: 1, event: "PREPARED", payload: {
        transactionId: request.transactionId,
        manifestSha256,
      } },
      { sequence: 2, event: "MOVING", payload: {} },
      ...["generated-next", "generated-node-modules", "copy-0001"].flatMap((id, index) => [
        { sequence: 3 + 2 * index, event: "MOVE_INTENT", payload: {
          id,
          expected: summaries.get(id),
        } },
        { sequence: 4 + 2 * index, event: "MOVED", payload: {
          id,
          observed: summaries.get(id),
        } },
      ]),
      { sequence: 9, event: "VERIFYING", payload: {} },
      { sequence: 10, event: "QUARANTINED", payload: {} },
    ]);
    expect(readdirSync(runRoot).filter((name) => name === "journal.lock" ||
      name.startsWith("journal.lock.tombstone."))).toEqual([]);
    expect(readdirSync(join(runRoot, "manifests")).some((name) =>
      name === "current" || name.includes("intermediate"))).toBe(false);
  });

  it("uses exact global byte order for two source copies and two generated roots", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, "alpha.txt"), "alpha\n");
    git(f.repoRoot, "add", "alpha.txt");
    git(f.repoRoot, "commit", "-m", "add second canonical");
    writeFileSync(join(f.repoRoot, "alpha 2.txt"), "alpha\n");
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const worker = invokeQuarantineWorker("apply", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 2,
      transactionId: "tx-global-entry-order",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const ids = ["generated-next", "copy-0001", "generated-node-modules", "copy-0002"];
    const movePhases = ids.flatMap((id) => [
      `after-event:MOVE_INTENT:${id}`,
      `after-rename:${id}`,
      `after-payload-sync:${id}`,
      `after-destination-parent-sync:${id}`,
      `after-source-parent-sync:${id}`,
      `after-inventory:moved-pass-1:${id}`,
      `after-event:MOVED:${id}`,
    ]);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      ...movePhases,
      "after-event:VERIFYING",
      ...ids.map((id) => `after-inventory:moved-pass-2:${id}`),
      "after-event:QUARANTINED",
      "before-lock-cleanup",
    ]);
    expect(worker.result).toMatchObject({ status: "QUARANTINED", movedEntries: 4 });
  });

  it("instruments real rename, fsync, and lock state at every public apply hook", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-public-hook-instrumentation";
    const worker = invokeQuarantineWorker("apply-instrumented", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const instrumentation = worker.instrumentation!;
    expect(instrumentation.snapshots.map(({ phase }) => phase)).toEqual(worker.phases);
    const runRoot = join(f.quarantineRoot, transactionId);
    const moves = [
      ["generated-next", join(f.repoRoot, ".next"), join(runRoot, "payload/generated/.next")],
      ["generated-node-modules", join(f.repoRoot, "node_modules"), join(runRoot, "payload/generated/node_modules")],
      ["copy-0001", join(f.repoRoot, "notes 2.txt"), join(runRoot, "payload/source-copies/copy-0001")],
    ] as const;
    expect(instrumentation.renamed).toEqual(moves.map(([, source, destination]) => [
      source,
      destination,
    ]));
    for (const [id, source, destination] of moves) {
      const atRename = instrumentation.snapshots.find(({ phase }) => phase === `after-rename:${id}`)!;
      expect(atRename.renamed).toContainEqual([source, destination]);
      const atPayload = instrumentation.snapshots.find(
        ({ phase }) => phase === `after-payload-sync:${id}`,
      )!;
      expect(atPayload.synced).toContain(destination);
      const atDestinationParent = instrumentation.snapshots.find(
        ({ phase }) => phase === `after-destination-parent-sync:${id}`,
      )!;
      expect(atDestinationParent.synced).toContain(dirname(destination));
      const atSourceParent = instrumentation.snapshots.find(
        ({ phase }) => phase === `after-source-parent-sync:${id}`,
      )!;
      expect(atSourceParent.synced).toContain(dirname(source));
      expect(existsSync(join(runRoot, "inventories/moved-pass-1", `${id}.jsonl`))).toBe(true);
      expect(existsSync(join(runRoot, "inventories/moved-pass-2", `${id}.jsonl`))).toBe(true);
    }
    const eventPhases = worker.phases!.filter((phase) => phase.startsWith("after-event:"));
    for (let index = 0; index < eventPhases.length; index += 1) {
      const snapshot = instrumentation.snapshots.find(({ phase }) => phase === eventPhases[index])!;
      const finalEvent = eventPhases[index] === "after-event:QUARANTINED";
      expect(snapshot.lockCreates).toBe(index + 1);
      expect(snapshot.lockRemovals).toBe(finalEvent ? index : index + 1);
      expect(snapshot.lockExists).toBe(finalEvent);
    }
    const beforeCleanup = instrumentation.snapshots.find(
      ({ phase }) => phase === "before-lock-cleanup",
    )!;
    expect(beforeCleanup).toMatchObject({ lockCreates: 10, lockRemovals: 9, lockExists: true });
    expect(instrumentation.lockCreates).toBe(10);
    expect(instrumentation.lockRemovals).toBe(10);
    expect(existsSync(join(runRoot, "journal.lock"))).toBe(false);
  });

  it("handles deterministic hook rejection at every public apply phase", () => {
    const ids = ["generated-next", "generated-node-modules", "copy-0001"];
    const phases = [
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      ...ids.flatMap((id) => [
        `after-event:MOVE_INTENT:${id}`,
        `after-rename:${id}`,
        `after-payload-sync:${id}`,
        `after-destination-parent-sync:${id}`,
        `after-source-parent-sync:${id}`,
        `after-inventory:moved-pass-1:${id}`,
        `after-event:MOVED:${id}`,
      ]),
      "after-event:VERIFYING",
      ...ids.map((id) => `after-inventory:moved-pass-2:${id}`),
      "after-event:QUARANTINED",
      "before-lock-cleanup",
    ];
    for (const [index, stopPhase] of phases.entries()) {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = `tx-hook-rejection-${String(index + 1).padStart(2, "0")}`;
      const worker = invokeQuarantineWorker("apply-stop", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        stopPhase,
      }, {}, 30_000);
      expect(worker.ok).toBe(false);
      expect(worker.phases?.at(-1)).toBe(stopPhase);
      if (stopPhase === "after-event:QUARANTINED" || stopPhase === "before-lock-cleanup") {
        expect(worker.error).toMatchObject({
          name: "QuarantineError",
          code: "ERR_INDETERMINATE_JOURNAL_APPEND",
        });
        expect(existsSync(join(f.quarantineRoot, transactionId, "journal.lock"))).toBe(true);
      } else {
        expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
      }
    }
  });

  it("prioritizes a durable PREPARED journal over precommit mismatch before Git discovery", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-existing-journal",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const seeded = invokeQuarantineWorker("seed-prepared", request, {}, 30_000);
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    writeFileSync(join(f.quarantineRoot, request.transactionId, "manifests", "foreign"), "preserve");
    const sentinel = join(f.base, "git-was-invoked");
    const bin = join(f.base, "reject-git");
    privateDirectory(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 99\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);

    const worker = invokeQuarantineWorker("apply", request, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expectWorkerError(
      worker,
      "ERR_RECOVERY_REQUIRED",
      "Explicit quarantine recovery is required.",
    );
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(
      join(f.quarantineRoot, request.transactionId, "manifests", "foreign"),
      "utf8",
    )).toBe("preserve");
  });

  it.each([
    ["MOVING", "after-event:MOVING", "journal"],
    ["VERIFYING", "after-event:VERIFYING", "torn-journal"],
    ["QUARANTINED", "after-event:QUARANTINED", "lock"],
  ] as const)(
    "prioritizes %s recovery evidence with %s residue before precommit and Git",
    (_stage, stopPhase, residue) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = `tx-gate-${residue}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invokeQuarantineWorker("apply-stop", { ...request, stopPhase }, {}, 30_000);
      expect(first.ok).toBe(false);
      const runRoot = join(f.quarantineRoot, transactionId);
      if (residue === "torn-journal") {
        appendFileSync(join(runRoot, "journal.log"), Buffer.from([0, 0, 0, 9, 0x7b]));
      }
      writeFileSync(join(runRoot, "manifests", "foreign"), "preserve", { mode: 0o600 });
      chmodSync(join(runRoot, "manifests", "foreign"), 0o600);
      const sentinel = join(f.base, "git-was-invoked");
      const bin = join(f.base, `reject-git-${residue}`);
      privateDirectory(bin);
      writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 99\n`, {
        mode: 0o700,
      });
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(
        invokeQuarantineWorker("apply", request, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
        "ERR_RECOVERY_REQUIRED",
        "Explicit quarantine recovery is required.",
      );
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(join(runRoot, "manifests", "foreign"), "utf8")).toBe("preserve");
    },
  );

  it.each(["lock", "tombstone"] as const)(
    "prioritizes a journal %s residue even without journal.log",
    (residue) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const transactionId = `tx-gate-residue-${residue}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const name = residue === "lock"
        ? "journal.lock"
        : "journal.lock.tombstone.11111111-1111-4111-8111-111111111111";
      const artifact = join(f.quarantineRoot, transactionId, name);
      writeFileSync(artifact, "foreign", { mode: 0o600 });
      chmodSync(artifact, 0o600);
      expectWorkerError(
        invokeQuarantineWorker("apply", request, {}, 30_000),
        "ERR_RECOVERY_REQUIRED",
        "Explicit quarantine recovery is required.",
      );
      expect(readFileSync(artifact, "utf8")).toBe("foreign");
    },
  );

  it("completes an ancestor-closed partial layout before advancing apply", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const runRoot = join(f.quarantineRoot, "tx-partial-layout");
    privateDirectory(runRoot);
    privateDirectory(join(runRoot, "manifests"));
    const worker = invokeQuarantineWorker("apply-stop-after-layout", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-partial-layout",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual(["after-layout-sync"]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop after layout" });
    for (const relativePath of LAYOUT_RELATIVES) {
      expect(statSync(relativePath === "" ? runRoot : join(runRoot, relativePath)).mode & 0o7777)
        .toBe(0o700);
    }
  });

  it("keeps direct prepare strict while private apply admits only closed precommit finals", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-private-resume",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const preInventory = join(
      f.quarantineRoot,
      request.transactionId,
      "inventories/pre/copy-0001.jsonl",
    );
    writeFileSync(preInventory, "preserve", { mode: 0o600 });
    chmodSync(preInventory, 0o600);
    expectWorkerError(
      invokeQuarantineWorker("prepare-raw", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    const apply = invokeQuarantineWorker("apply-stop-after-layout", request, {}, 30_000);
    expect(apply.ok).toBe(false);
    expect(apply.phases).toEqual(["after-layout-sync"]);
    expect(apply.error).toMatchObject({ name: "RangeError", message: "stop after layout" });
    expect(readFileSync(preInventory, "utf8")).toBe("preserve");
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(preInventory, "utf8")).toBe("preserve");
  });

  it("publishes exact pre inventories and one immutable generation before durable PREPARED", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-prepared-boundary";
    const worker = invokeQuarantineWorker("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-event:PREPARED",
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
    ]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    const runRoot = join(f.quarantineRoot, transactionId);
    for (const id of ["generated-next", "generated-node-modules", "copy-0001"]) {
      const path = join(runRoot, "inventories/pre", `${id}.jsonl`);
      expect(statSync(path).mode & 0o7777).toBe(0o600);
      expect(readFileSync(path).length).toBeGreaterThan(0);
    }
    const generations = readdirSync(join(runRoot, "manifests"));
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(statSync(join(runRoot, "journal.log")).mode & 0o7777).toBe(0o600);
    expect(existsSync(join(f.repoRoot, ".next"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "node_modules"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(true);
  });

  it("streams and durably publishes each divergent patch before PREPARED", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-divergent-patch";
    const worker = invokeQuarantineWorker("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-divergent-diff:copy-0001",
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-divergent-diff:copy-0001",
    ]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    const diffRoot = join(f.quarantineRoot, transactionId, "divergent-diffs");
    expect(statSync(join(diffRoot, "copy-0001.patch")).mode & 0o7777).toBe(0o600);
    expect(readFileSync(join(diffRoot, "copy-0001.patch")).length).toBeGreaterThan(0);
    expect(existsSync(join(diffRoot, ".copy-0001.tmp"))).toBe(false);
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it.each([
    ["cap", 0, 1, true],
    ["cap-plus-one", 1, 1, false],
    ["stderr-limit", -1, 1, true],
    ["stderr-overflow", -2, 1, false],
    ["exit-zero", -1, 0, false],
  ] as const)(
    "bounds and settles the divergent Git child case %s",
    (label, capDelta, exit, succeeds) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const cap = 4 * (
        statSync(join(f.repoRoot, f.canonicalPath!)).size +
        statSync(join(f.repoRoot, f.copyPath!)).size
      ) + 1_048_576;
      const stdout = capDelta >= 0
        ? Buffer.alloc(cap + capDelta, 0x61)
        : Buffer.from("canonical patch bytes\n");
      const stderr = capDelta === -1
        ? Buffer.alloc(64 * 1024, 0x65)
        : capDelta === -2
          ? Buffer.alloc(64 * 1024 + 1, 0x65)
          : Buffer.alloc(0);
      const path = installGitDiffOverride(f, label, stdout, { stderr, exit });
      const worker = invokeQuarantineWorker("apply", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: `tx-diff-${label}`,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      }, { PATH: path }, 30_000);
      if (succeeds) {
        if (!worker.ok) throw new Error(JSON.stringify(worker.error));
        expect(worker.result).toMatchObject({ status: "QUARANTINED" });
      } else {
        expectWorkerError(
          worker,
          "ERR_INTEGRITY",
          "Quarantine evidence failed integrity validation.",
        );
      }
    },
  );

  it.each([
    ["nonzero", { exit: 2 }],
    ["partial-signal", { signal: "TERM" }],
  ] as const)("rejects and settles a divergent Git child %s outcome", (label, outcome) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const diff = canonicalDiff(f);
    const path = installGitDiffOverride(
      f,
      label,
      label === "partial-signal" ? diff.subarray(0, Math.max(1, Math.floor(diff.length / 2))) : diff,
      outcome,
    );
    const transactionId = `tx-child-${label}`;
    expectWorkerError(
      invokeQuarantineWorker("apply", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      }, { PATH: path }, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("rejects and settles a divergent Git child spawn error", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const path = installGitDiffOverride(f, "spawn-error", canonicalDiff(f));
    const isolatedBin = path.slice(0, path.indexOf(":"));
    const transactionId = "tx-child-spawn-error";
    const worker = invokeQuarantineWorker("apply-divergent-spawn-error", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: isolatedBin }, 30_000);
    expect(worker.injected).toBe(true);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it.each(["safe-boundary", "overflow"] as const)(
    "checks the divergent cap %s before spawning Git",
    (variant) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const largestSafeCombined = Math.floor(
        (Number.MAX_SAFE_INTEGER - 1_048_576) / 4,
      );
      const combined = variant === "safe-boundary"
        ? largestSafeCombined
        : largestSafeCombined + 1;
      const virtualSourceSize = Math.floor(combined / 2);
      const virtualCanonicalSize = combined - virtualSourceSize;
      const sentinel = join(f.base, `diff-spawn-${variant}`);
      const path = installGitDiffOverride(
        f,
        `virtual-cap-${variant}`,
        canonicalDiff(f),
        { sentinel },
      );
      const transactionId = `tx-virtual-cap-${variant}`;
      const worker = invokeQuarantineWorker("apply-virtual-cap", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        virtualSourceSize,
        virtualCanonicalSize,
        stopPhase: "after-divergent-diff:copy-0001",
      }, { PATH: path }, 30_000);
      if (variant === "safe-boundary") {
        expect(worker.ok).toBe(false);
        expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
        expect(existsSync(sentinel)).toBe(true);
      } else {
        expectWorkerError(
          worker,
          "ERR_INTEGRITY",
          "Quarantine evidence failed integrity validation.",
        );
        expect(existsSync(sentinel)).toBe(false);
      }
      expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
    },
  );

  it("keeps canonical re-comparison reads bounded to 64 KiB for multi-MiB output", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, f.canonicalPath!), Buffer.alloc(1024 * 1024, 0x61));
    git(f.repoRoot, "add", f.canonicalPath!);
    git(f.repoRoot, "commit", "-m", "large canonical");
    writeFileSync(join(f.repoRoot, f.copyPath!), Buffer.alloc(1024 * 1024, 0x62));
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const transactionId = "tx-bounded-canonical-compare";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const output = Buffer.alloc(6 * 1024 * 1024, 0x70);
    const temporary = join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/.copy-0001.tmp",
    );
    writeFileSync(temporary, output, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    const path = installGitDiffOverride(f, "bounded-canonical-compare", output);
    const worker = invokeQuarantineWorker("apply-observe-read-bound", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, { PATH: path }, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    expect(worker.maxReadLength).toBe(64 * 1024);
    expect(readFileSync(join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/copy-0001.patch",
    )).length).toBe(output.length);
  });

  it("keeps final-only two-file comparison reads bounded to 64 KiB", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, f.canonicalPath!), Buffer.alloc(1024 * 1024, 0x63));
    git(f.repoRoot, "add", f.canonicalPath!);
    git(f.repoRoot, "commit", "-m", "large final-only canonical");
    writeFileSync(join(f.repoRoot, f.copyPath!), Buffer.alloc(1024 * 1024, 0x64));
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const transactionId = "tx-bounded-final-only-compare";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const output = Buffer.alloc(6 * 1024 * 1024, 0x71);
    const path = installGitDiffOverride(f, "bounded-final-only-compare", output);
    const first = invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, { PATH: path }, 30_000);
    expect(first.ok).toBe(false);
    const worker = invokeQuarantineWorker("apply-observe-read-bound", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, { PATH: path }, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    expect(worker.maxReadLength).toBe(64 * 1024);
    expect(readFileSync(join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/copy-0001.patch",
    )).length).toBe(output.length);
  });

  it.each([false, true])(
    "settles the left compare handle exactly once when right open fails (closeFailure=%s)",
    (closeFailure) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-right-open-failure-${closeFailure}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invokeQuarantineWorker("apply-stop", {
        ...request,
        stopPhase: "after-divergent-diff:copy-0001",
      }, {}, 30_000);
      expect(first.ok).toBe(false);
      const worker = invokeQuarantineWorker("apply-final-only-right-open-failure", {
        ...request,
        closeFailure,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      expect(worker.closeGetterReads).toBe(1);
      expect(worker.closeCalls).toBe(1);
      expect(worker.closeWrongReceiver).toBe(0);
    },
  );

  it("settles a true Git stdout stream error independently of child signals", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-child-stdout-error";
    const worker = invokeWithGitStdoutError({
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker).toMatchObject({
      ok: false,
      error: {
        name: "QuarantineError",
        code: "ERR_INTEGRITY",
        message: "Quarantine evidence failed integrity validation.",
      },
    });
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("keeps hostile external-diff and textconv drivers disabled", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const sentinel = join(f.base, "hostile-diff-ran");
    const driver = join(f.base, "hostile-diff.sh");
    writeFileSync(driver, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 99\n`, {
      mode: 0o700,
    });
    chmodSync(driver, 0o700);
    writeFileSync(join(f.repoRoot, ".gitattributes"), "*.txt diff=hostile\n");
    git(f.repoRoot, "add", ".gitattributes");
    git(f.repoRoot, "commit", "-m", "hostile diff attributes");
    git(f.repoRoot, "config", "diff.external", driver);
    git(f.repoRoot, "config", "diff.hostile.textconv", driver);
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const worker = invokeQuarantineWorker("apply", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-hostile-diff",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "QUARANTINED" });
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    ["zero-byte", Buffer.alloc(0)],
    ["binary", Buffer.from([0, 1, 2, 255])],
    ["no-final-newline", Buffer.from("older content")],
  ] as const)("publishes an actual Git patch with a %s source side", (label, body) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, f.copyPath!), body);
    const worker = invokeQuarantineWorker("apply", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-patch-${label}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const patch = readFileSync(join(
      f.quarantineRoot,
      `tx-patch-${label}`,
      "divergent-diffs/copy-0001.patch",
    ));
    expect(patch.length).toBeGreaterThan(0);
  });

  it("durably records intent, rename syncs, pass-1 inventory, and MOVED per entry", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-first-moved";
    const worker = invokeQuarantineWorker("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-event:MOVED:generated-next",
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      "after-event:MOVE_INTENT:generated-next",
      "after-rename:generated-next",
      "after-payload-sync:generated-next",
      "after-destination-parent-sync:generated-next",
      "after-source-parent-sync:generated-next",
      "after-inventory:moved-pass-1:generated-next",
      "after-event:MOVED:generated-next",
    ]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    const runRoot = join(f.quarantineRoot, transactionId);
    expect(existsSync(join(f.repoRoot, ".next"))).toBe(false);
    expect(existsSync(join(runRoot, "payload/generated/.next"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "node_modules"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(true);
    expect(statSync(join(
      runRoot,
      "inventories/moved-pass-1/generated-next.jsonl",
    )).mode & 0o7777).toBe(0o600);
  });

  it.each([false, true])(
    "recomputes and adopts exact precommit finals on retry (divergent=%s)",
    (divergent) => {
      const f = createQuarantineFixture({ divergent });
      bases.push(f.base);
      const transactionId = divergent ? "tx-retry-divergent" : "tx-retry-generation";
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invokeQuarantineWorker("apply-stop", {
        ...request,
        stopPhase: divergent
          ? "after-divergent-diff:copy-0001"
          : "after-prepared-generation",
      }, {}, 30_000);
      expect(first.ok).toBe(false);
      expect(first.error).toMatchObject({ name: "RangeError" });
      const second = invokeQuarantineWorker("apply", request, {}, 30_000);
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      expect(second.result).toMatchObject({
        transactionId,
        status: "QUARANTINED",
        movedEntries: 3,
      });
    },
  );

  it("adopts all exact pre inventories after the inventory publication seam", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-retry-inventories";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const first = invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: "after-pre-inventories",
    }, {}, 30_000);
    expect(first.ok).toBe(false);
    const second = invokeQuarantineWorker("apply", request, {}, 30_000);
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.result).toMatchObject({ status: "QUARANTINED", movedEntries: 3 });
  });

  it.each(["after-event:QUARANTINED", "before-lock-cleanup"])(
    "maps final in-lock hook rejection at %s to indeterminate and preserves evidence",
    (stopPhase) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-final-hook";
    const worker = invokeQuarantineWorker("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INDETERMINATE_JOURNAL_APPEND",
      "Journal durability could not be determined.",
    );
    expect(worker.phases?.at(-1)).toBe(stopPhase);
    const runRoot = join(f.quarantineRoot, transactionId);
    expect(existsSync(join(runRoot, "journal.log"))).toBe(true);
    expect(existsSync(join(runRoot, "journal.lock"))).toBe(true);
    },
  );

  it.each([
    ["unchanged", "ERR_EXDEV"],
    ["source-changed", "ERR_INTEGRITY"],
    ["destination-created", "ERR_INTEGRITY"],
  ] as const)("classifies rename EXDEV only after fresh evidence checks (%s)", (variant, code) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const source = join(f.repoRoot, ".next");
    const destination = join(f.quarantineRoot, `tx-exdev-${variant}`, "payload/generated/.next");
    const sourceBefore = lstatSync(source);
    const worker = invokeQuarantineWorker("apply-rename-exdev", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-exdev-${variant}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      variant,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      code,
      code === "ERR_EXDEV"
        ? "Repository and quarantine must be on the same filesystem."
        : "Quarantine evidence failed integrity validation.",
    );
    expect(worker.unlinkCalls).toBe(0);
    if (code === "ERR_EXDEV") {
      const sourceAfter = lstatSync(source);
      expect([sourceAfter.dev, sourceAfter.ino]).toEqual([sourceBefore.dev, sourceBefore.ino]);
      expect(existsSync(destination)).toBe(false);
    }
  });

  it.each([
    ["generated parent after intent", "generated-next", "after-event:MOVE_INTENT:generated-next"],
    ["source-copies parent after intent", "copy-0001", "after-event:MOVE_INTENT:copy-0001"],
  ] as const)(
    "does not follow an external %s symlink before rename",
    (_label, targetId, triggerPhase) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const externalRoot = join(f.base, `external-${targetId}`);
      privateDirectory(externalRoot);
      writeFileSync(join(externalRoot, "sentinel"), "preserve");
      const transactionId = `tx-endpoint-intent-${targetId}`;
      const worker = invokeQuarantineWorker("apply-endpoint-swap", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        variant: "destination-before-rename",
        triggerPhase,
        targetId,
        externalRoot,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      expect(worker.externalOperations).toEqual([]);
      expect(worker.replayEvents).not.toContainEqual({
        event: "MOVED",
        payload: expect.objectContaining({ id: targetId }),
      });
      expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
      expect(existsSync(join(
        externalRoot,
        targetId === "generated-next" ? ".next" : "copy-0001",
      ))).toBe(false);
      expect(existsSync(join(
        f.repoRoot,
        targetId === "generated-next" ? ".next" : "notes 2.txt",
      ))).toBe(true);
    },
  );

  it("does not follow a nested source ancestor moved outside and replaced by a symlink", () => {
    const f = createQuarantineFixture({
      canonicalPath: "nested/deeper/notes.txt",
      copyPath: "nested/deeper/notes 2.txt",
    });
    bases.push(f.base);
    const externalRoot = join(f.base, "external-source-ancestor");
    privateDirectory(externalRoot);
    writeFileSync(join(externalRoot, "sentinel"), "preserve");
    const sourceAncestor = join(f.repoRoot, "nested");
    const transactionId = "tx-endpoint-source-ancestor";
    const worker = invokeQuarantineWorker("apply-endpoint-swap", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      variant: "source-ancestor",
      triggerPhase: "after-event:MOVE_INTENT:copy-0001",
      targetId: "copy-0001",
      sourceAncestor,
      externalRoot,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(worker.externalOperations).toEqual([]);
    expect(worker.replayEvents).not.toContainEqual({
      event: "MOVED",
      payload: expect.objectContaining({ id: "copy-0001" }),
    });
    expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(join(
      externalRoot,
      "source-ancestor-owned/deeper/notes 2.txt",
    ))).toBe(true);
  });

  it.each([
    ["after payload fsync", "after-payload-sync:generated-next"],
    ["before inventory", "after-destination-parent-sync:generated-next"],
  ] as const)("does not open an external payload parent %s", (_label, triggerPhase) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const externalRoot = join(f.base, `external-${triggerPhase.replaceAll(":", "-")}`);
    privateDirectory(externalRoot);
    writeFileSync(join(externalRoot, "sentinel"), "preserve");
    const transactionId = `tx-endpoint-${triggerPhase.replaceAll(":", "-")}`;
    const worker = invokeQuarantineWorker("apply-endpoint-swap", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      variant: "destination-after-move",
      triggerPhase,
      targetId: "generated-next",
      externalRoot,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(worker.externalOperations).toEqual([]);
    expect(worker.replayEvents).not.toContainEqual({
      event: "MOVED",
      payload: expect.objectContaining({ id: "generated-next" }),
    });
    expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(join(externalRoot, "payload-parent-owned/.next"))).toBe(true);
  });

  it.each([
    ["generated after MOVED", "generated-node-modules", "after-event:MOVED:generated-node-modules", "MOVED"],
    ["source-copy after MOVED", "copy-0001", "after-event:MOVED:copy-0001", "MOVED"],
    ["generated after VERIFYING", "generated-node-modules", "after-event:VERIFYING", "VERIFYING"],
    ["source-copy after VERIFYING", "copy-0001", "after-event:VERIFYING", "VERIFYING"],
    [
      "generated after pass-2 inventory",
      "generated-node-modules",
      "after-inventory:moved-pass-2:generated-node-modules",
      "VERIFYING",
    ],
    [
      "source-copy after pass-2 inventory",
      "copy-0001",
      "after-inventory:moved-pass-2:copy-0001",
      "VERIFYING",
    ],
  ] as const)(
    "stops at the carried endpoint boundary %s",
    (_label, targetId, triggerPhase, expectedLastEvent) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const externalRoot = join(
        f.base,
        `external-late-${targetId}-${triggerPhase.replaceAll(":", "-")}`,
      );
      privateDirectory(externalRoot);
      writeFileSync(join(externalRoot, "sentinel"), "preserve");
      const transactionId = `tx-late-${targetId}-${triggerPhase.replaceAll(":", "-")}`;
      const worker = invokeQuarantineWorker("apply-endpoint-swap", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        variant: "destination-after-move",
        triggerPhase,
        targetId,
        externalRoot,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      expect(worker.externalOperations).toEqual([]);
      expect(worker.replayEvents).not.toContainEqual({
        event: "QUARANTINED",
        payload: {},
      });
      const last = worker.replayEvents?.at(-1);
      expect(last?.event).toBe(expectedLastEvent);
      if (expectedLastEvent === "MOVED") expect(last?.payload.id).toBe(targetId);
      expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "maps append lock-cleanup failure %i to indeterminate at the exact durable event",
    (failCleanupAt) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = `tx-lock-cleanup-${failCleanupAt}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const worker = invokeQuarantineWorker("apply-lock-cleanup-failure", {
      ...request,
      failCleanupAt,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INDETERMINATE_JOURNAL_APPEND",
      "Journal durability could not be determined.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.lock"))).toBe(true);
    expect(worker.mutationCounters?.atFailure).toEqual(worker.mutationCounters?.final);
    expect(worker.mutationCounters?.final).toMatchObject({
      generationPublications: 1,
      journalMutations: failCleanupAt,
    });
    const replay = invokeQuarantineWorker("replay-run", request, {}, 30_000);
    if (!replay.ok) throw new Error(JSON.stringify(replay.error));
    const records = replay.result?.records as Array<{
      sequence: number;
      event: string;
      payload: { id?: string; manifestSha256?: string; transactionId?: string };
    }>;
    const expected = [
      ["PREPARED", undefined],
      ["MOVING", undefined],
      ["MOVE_INTENT", "generated-next"],
      ["MOVED", "generated-next"],
      ["MOVE_INTENT", "generated-node-modules"],
      ["MOVED", "generated-node-modules"],
      ["MOVE_INTENT", "copy-0001"],
      ["MOVED", "copy-0001"],
      ["VERIFYING", undefined],
      ["QUARANTINED", undefined],
    ] as const;
    expect(records.map((record) => [record.event, record.payload.id])).toEqual(
      expected.slice(0, failCleanupAt),
    );
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: failCleanupAt }, (_, index) => index + 1),
    );
    expect(records[0]).toMatchObject({
      sequence: 1,
      event: "PREPARED",
      payload: {
        transactionId,
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    const manifestSha256 = records[0].payload.manifestSha256!;
    const runRoot = join(f.quarantineRoot, transactionId);
    expect(readdirSync(join(runRoot, "manifests"))).toEqual([`${manifestSha256}.json`]);
    const manifestPath = join(runRoot, "manifests", `${manifestSha256}.json`);
    const beforeReplayBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(beforeReplayBytes.toString("utf8"));
    expect(beforeReplayBytes).toEqual(Buffer.from(`${JSON.stringify(manifest)}\n`));
    expect(createHash("sha256").update(beforeReplayBytes).digest("hex")).toBe(manifestSha256);
    expect(manifest).toMatchObject({
      transactionId,
      state: "PREPARED",
      retentionDays: 4,
      deletionRequiresConfirmation: true,
    });
    expect(manifest.entries).toHaveLength(3);
    for (const entry of manifest.entries) {
      expect(entry.preMoveInventory).toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        entries: expect.any(Number),
        bytes: expect.any(Number),
      });
    }
    expect(readFileSync(manifestPath)).toEqual(beforeReplayBytes);
    expect(existsSync(join(f.quarantineRoot, "current"))).toBe(false);
    expect(readdirSync(join(runRoot, "manifests")).some((name) =>
      name === "current" || name.includes("intermediate"))).toBe(false);
    },
  );

  it.each([
    ["after-source-parent-sync:generated-next", "payload"],
    ["after-event:VERIFYING", "payload"],
    ["after-inventory:moved-pass-2:copy-0001", "source"],
    ["after-inventory:moved-pass-2:copy-0001", "status"],
  ] as const)("fails closed on final verification drift at %s (%s)", (mutatePhase, mutation) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("apply-mutate-at-hook", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-verify-${mutation}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      mutatePhase,
      mutation,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
  });

  it("preserves and rejects a wrong-mode adopted divergent final", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-wrong-mode-patch";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const first = invokeQuarantineWorker("apply-stop", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, {}, 30_000);
    expect(first.ok).toBe(false);
    const final = join(f.quarantineRoot, transactionId, "divergent-diffs/copy-0001.patch");
    chmodSync(final, 0o644);
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(final).length).toBeGreaterThan(0);
    expect(statSync(final).mode & 0o7777).toBe(0o644);
  });

  it.each(["temp-only", "final-plus-temp"] as const)(
    "recomputes and adopts an exact preexisting divergent %s artifact set",
    (variant) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-${variant}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const diff = spawnSync("git", [
        "-c", "core.fsmonitor=false",
        "-c", "core.quotePath=true",
        "diff", "--no-index", "--binary", "--full-index", "--no-color",
        "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--",
        f.canonicalPath!, f.copyPath!,
      ], { cwd: f.repoRoot });
      expect(diff.status).toBe(1);
      const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
      const temporary = join(root, ".copy-0001.tmp");
      const final = join(root, "copy-0001.patch");
      writeFileSync(temporary, diff.stdout, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      if (variant === "final-plus-temp") linkSync(temporary, final);
      const applied = invokeQuarantineWorker("apply", request, {}, 30_000);
      if (!applied.ok) throw new Error(JSON.stringify(applied.error));
      expect(applied.result).toMatchObject({ status: "QUARANTINED" });
      expect(readFileSync(final)).toEqual(diff.stdout);
      expect(existsSync(temporary)).toBe(false);
    },
  );

  it.each([
    ["normal", "append", 1],
    ["normal", "truncate", 1],
    ["final-only", "append", 1],
    ["final-only", "truncate", 1],
    ["temp-only", "append", 1],
    ["temp-only", "truncate", 1],
    ["final-plus-temp", "append", 1],
    ["final-plus-temp", "truncate", 1],
  ] as const)(
    "rejects same-inode %s divergent evidence after an in-place %s",
    (variant, mutation, driftAtFinalOpen) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-size-drift-${variant}-${mutation}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const diffRoot = join(f.quarantineRoot, transactionId, "divergent-diffs");
      const temporary = join(diffRoot, ".copy-0001.tmp");
      const final = join(diffRoot, "copy-0001.patch");
      if (variant === "final-only") {
        const first = invokeQuarantineWorker("apply-stop", {
          ...request,
          stopPhase: "after-divergent-diff:copy-0001",
        }, {}, 30_000);
        expect(first.ok).toBe(false);
        expect(existsSync(final)).toBe(true);
      } else if (variant !== "normal") {
        const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
        if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
        writeFileSync(temporary, canonicalDiff(f), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        if (variant === "final-plus-temp") linkSync(temporary, final);
      }
      expectWorkerError(
        invokeQuarantineWorker("apply-same-inode-size-drift", {
          ...request,
          driftAtFinalOpen,
          mutation,
        }, {}, 30_000),
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
    },
  );

  it.each(
    (["normal", "temp-only", "final-plus-temp"] as const).flatMap((variant) =>
      ([
        "before-link",
        "after-link",
        "after-file-sync",
        "before-parent-sync",
        "after-parent-sync",
        "cleanup-before-parent-sync",
        "cleanup-after-parent-sync-final",
        "cleanup-after-parent-sync-temp",
      ] as const).map((seam) => [variant, seam] as const)),
  )("rejects a %s divergent artifact swap at %s", (variant, seam) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = `tx-seam-${variant}-${seam}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    if (variant !== "normal") {
      const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
      const temporary = join(root, ".copy-0001.tmp");
      writeFileSync(temporary, canonicalDiff(f), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      if (variant === "final-plus-temp") {
        linkSync(temporary, join(root, "copy-0001.patch"));
      }
    }
    const worker = invokeQuarantineWorker("apply-divergent-seam-swap", {
      ...request,
      variant,
      seam,
    }, {}, 30_000);
    expect(worker.injected).toBe(true);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("preserves a mismatching preexisting divergent temporary", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-mismatch-temp";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const temporary = join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/.copy-0001.tmp",
    );
    writeFileSync(temporary, "foreign", { mode: 0o600 });
    chmodSync(temporary, 0o600);
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(temporary, "utf8")).toBe("foreign");
  });

  it.each([
    ["temporary", "symlink"],
    ["temporary", "directory"],
    ["final", "symlink"],
    ["final", "directory"],
  ] as const)("preserves and rejects a nonregular divergent %s %s", (artifact, kind) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = `tx-nonregular-${artifact}-${kind}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
    const temporary = join(root, ".copy-0001.tmp");
    const final = join(root, "copy-0001.patch");
    if (artifact === "final") {
      writeFileSync(temporary, canonicalDiff(f), { mode: 0o600 });
      chmodSync(temporary, 0o600);
    }
    const target = artifact === "temporary" ? temporary : final;
    if (kind === "symlink") symlinkSync(f.canonicalPath!, target);
    else privateDirectory(target);
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(lstatSync(target).isSymbolicLink()).toBe(kind === "symlink");
    expect(lstatSync(target).isDirectory()).toBe(kind === "directory");
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("preserves an EEXIST divergent final collision and removes its owned temporary", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-divergent-eexist-collision";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
    const temporary = join(root, ".copy-0001.tmp");
    const final = join(root, "copy-0001.patch");
    writeFileSync(final, "foreign-final", { mode: 0o600 });
    chmodSync(final, 0o600);
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(final, "utf8")).toBe("foreign-final");
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("fails closed and preserves a divergent temporary that reappears after cleanup", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-temp-reappears";
    const worker = invokeQuarantineWorker("apply-temp-reappear", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
    expect(readFileSync(join(root, ".copy-0001.tmp"), "utf8")).toBe("foreign-reappeared");
    expect(existsSync(join(root, "copy-0001.patch"))).toBe(true);
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it.each(["parent-sync-failure", "final-swap"] as const)(
    "does not advance after divergent temporary cleanup seam %s",
    (variant) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-cleanup-${variant}`;
      const worker = invokeQuarantineWorker("apply-temp-cleanup-seam", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        variant,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
      expect(existsSync(join(root, "copy-0001.patch"))).toBe(true);
      expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
      if (variant === "final-swap") {
        expect(readFileSync(join(root, "copy-0001.patch"), "utf8")).toBe("foreign-final");
        expect(existsSync(join(root, "copy-0001.patch.owned"))).toBe(true);
      }
    },
  );

  it("preserves and rejects a syntactically valid but wrong manifest generation", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-wrong-generation";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const generation = join(
      f.quarantineRoot,
      transactionId,
      "manifests",
      `${"0".repeat(64)}.json`,
    );
    writeFileSync(generation, "{}", { mode: 0o600 });
    chmodSync(generation, 0o600);
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(generation, "utf8")).toBe("{}");
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("rejects an undiscovered but syntactically valid precommit entry before publication", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const transactionId = "tx-undiscovered-precommit";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invokeQuarantineWorker("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const foreign = join(
      f.quarantineRoot,
      transactionId,
      "inventories/pre/copy-9999.jsonl",
    );
    writeFileSync(foreign, "foreign", { mode: 0o600 });
    chmodSync(foreign, 0o600);
    expectWorkerError(
      invokeQuarantineWorker("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(foreign, "utf8")).toBe("foreign");
    expect(existsSync(join(
      f.quarantineRoot,
      transactionId,
      "inventories/pre/copy-0001.jsonl",
    ))).toBe(false);
  });

  it("returns the exact body-free INSPECTED summary without writing quarantine", async () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const before = readFileSync(join(f.repoRoot, "notes 2.txt"));
    const worker = invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const result = worker.result!;

    expect(worker.shape).toMatchObject({
      prototype: "null",
      keys: [
      "status",
      "totalEntries",
      "sourceCopies",
      "generatedRoots",
      "identicalCopies",
      "divergentCopies",
      "branch",
      "head",
      "sameDevice",
      ],
      frozen: true,
      extensible: false,
    });
    for (const descriptor of Object.values(worker.shape!.descriptors)) {
      expect(descriptor).toMatchObject({ enumerable: true, configurable: false, writable: false });
    }
    expect(worker.shape!.mutationStable).toBe(true);
    expect(result).toEqual({
      status: "INSPECTED",
      totalEntries: 3,
      sourceCopies: 1,
      generatedRoots: 2,
      identicalCopies: 1,
      divergentCopies: 0,
      branch: f.branch,
      head: f.head,
      sameDevice: true,
    });
    expect(readFileSync(join(f.repoRoot, "notes 2.txt"))).toEqual(before);
    expect(readdirSync(f.quarantineRoot)).toEqual([]);
  });

  it("snapshots closed options and emits only fixed sanitized usage errors", async () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const options = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    };
    const getter = invokeQuarantineWorker("getter", options);
    if (!getter.ok) throw new Error(JSON.stringify(getter.error));
    expect(getter.reads).toBe(1);
    const invalid = invokeQuarantineWorker("inspect", { ...options, secretPath: "/do/not/leak" });
    expectWorkerError(invalid, "ERR_USAGE", "Invalid quarantine request.");
    expect(invalid.error!.leaksSecret).toBe(false);
    const missing = { ...options } as Partial<typeof options>;
    delete missing.repoRoot;
    expectWorkerError(invokeQuarantineWorker("inspect", missing), "ERR_USAGE", "Invalid quarantine request.");
  });

  it("creates and durably adopts only the fixed private layout", async () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-slice-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true as const,
    };
    const firstWorker = invokeQuarantineWorker("prepare", request);
    const secondWorker = invokeQuarantineWorker("prepare", request);
    if (!firstWorker.ok) throw new Error(JSON.stringify(firstWorker.error));
    if (!secondWorker.ok) throw new Error(JSON.stringify(secondWorker.error));
    const first = firstWorker.result!;
    const second = secondWorker.result!;
    const firstShape = firstWorker.shape!;

    expect(firstWorker.phases).toEqual(["after-layout-sync"]);
    expect(secondWorker.phases).toEqual(["after-layout-sync"]);
    expect(firstShape.top).toMatchObject({
      prototype: "null",
      keys: [
      "status",
      "transactionId",
      "createdAt",
      "repoRoot",
      "quarantineRoot",
      "runRoot",
      "branch",
      "head",
      "entries",
      "fsSource",
      ],
      frozen: true,
      extensible: false,
    });
    expect(first.status).toBe("LAYOUT_READY");
    expect(first.runRoot).toBe(join(f.quarantineRoot, "tx-slice-1"));
    expect(first.entries).toHaveLength(3);
    expect(first.entries!.map((entry) => entry.id)).toEqual([
      "generated-next",
      "generated-node-modules",
      "copy-0001",
    ]);
    expect(firstShape.entries).toMatchObject({ prototype: "array", frozen: true, extensible: false });
    expect(firstShape.entries!.descriptors.length).toMatchObject({
      enumerable: false, writable: false, configurable: false,
    });
    expect(firstShape.fsSource).toMatchObject({
      prototype: "null", keys: [...FS_METHODS], frozen: true, extensible: false,
    });
    expect(firstShape.fsCallable).toBe(true);
    expect(firstShape.fsStable).toBe(true);
    expect(firstShape.mutationStable).toBe(true);
    expect(firstShape.entries!.keys).toEqual(["0", "1", "2", "length"]);
    for (const descriptor of Object.values(firstShape.top!.descriptors)) {
      expect(descriptor).toMatchObject({ enumerable: true, writable: false, configurable: false });
    }
    for (const [key, descriptor] of Object.entries(firstShape.entries!.descriptors)) {
      expect(descriptor).toMatchObject({
        enumerable: key !== "length", writable: false, configurable: false,
      });
    }
    for (const descriptor of Object.values(firstShape.fsSource!.descriptors)) {
      expect(descriptor).toMatchObject({
        enumerable: true, writable: false, configurable: false, callable: true,
      });
    }
    for (const shape of [...firstShape.entryShapes!, ...firstShape.identityShapes!.flat().filter((value): value is ValueShape => value !== null)]) {
      expect(shape).toMatchObject({ prototype: "null", frozen: true, extensible: false });
      for (const descriptor of Object.values(shape.descriptors)) {
        expect(descriptor).toMatchObject({ enumerable: true, writable: false, configurable: false });
      }
    }
    expect(firstShape.entryShapes!.map((shape) => shape.keys)).toEqual([
      ["id", "kind", "relativePath", "sourceIdentity"],
      ["id", "kind", "relativePath", "sourceIdentity"],
      [
        "id", "kind", "relativePath", "canonicalRelativePath", "sourceIdentity",
        "canonicalIdentity", "classification", "historyMatch",
      ],
    ]);
    expect(firstShape.identityShapes!.map((pair) => pair.map((shape) => shape?.keys ?? null))).toEqual([
      [["dev", "ino", "mode"], null],
      [["dev", "ino", "mode"], null],
      [
        ["dev", "ino", "mode", "size", "sha256"],
        ["dev", "ino", "mode", "size", "sha256"],
      ],
    ]);
    expect(second.entries).toEqual(first.entries);

    for (const relativePath of LAYOUT_RELATIVES) {
      const stats = statSync(relativePath === "" ? first.runRoot! : join(first.runRoot!, relativePath));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o7777).toBe(0o700);
    }
  });

  it.each(LAYOUT_RELATIVES)("adopts and re-syncs prefix %s after parent sync fails", (failureRelative) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("layout-retry", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-retry",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      failureRelative,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.firstCode).toBe("ERR_PREFLIGHT");
    expect(worker.runRootOpenAttempts).toBeGreaterThanOrEqual(2);
    expect(worker.result).toMatchObject({ status: "LAYOUT_READY", transactionId: "tx-retry" });
  });

  it("hands the exact captured filesystem source to a revocable run capability", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("capability-handoff", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-capability",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker).toMatchObject({
      active: { callable: true, distinctRejected: true },
      revoked: true,
      sourceFrozen: true,
    });
  });

  it("rejects writer work before attestation and preserves a foreign partial layout", async () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const baseRequest = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-slice-1",
      createdAt: "2026-07-16T00:00:00.000Z",
    };
    expectWorkerError(
      invokeQuarantineWorker("prepare-raw", { ...baseRequest, writersStopped: false }),
      "ERR_USAGE",
      "Invalid quarantine request.",
    );
    expect(readdirSync(f.quarantineRoot)).toEqual([]);

    const runRoot = join(f.quarantineRoot, "tx-slice-1");
    privateDirectory(runRoot);
    writeFileSync(join(runRoot, "foreign"), "preserve me");
    expectWorkerError(
      invokeQuarantineWorker("prepare-raw", { ...baseRequest, writersStopped: true }),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(join(runRoot, "foreign"), "utf8")).toBe("preserve me");
    expect(readdirSync(runRoot)).toEqual(["foreign"]);
  });

  it.each(["file", "wrong-mode", "symlink"] as const)(
    "preserves and rejects an invalid existing layout child of kind %s",
    (kind) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const runRoot = join(f.quarantineRoot, "tx-invalid-layout");
      privateDirectory(runRoot);
      const child = join(runRoot, "manifests");
      if (kind === "file") writeFileSync(child, "foreign-file");
      if (kind === "wrong-mode") {
        privateDirectory(child);
        chmodSync(child, 0o755);
      }
      if (kind === "symlink") {
        const target = join(f.base, "external-layout");
        privateDirectory(target);
        writeFileSync(join(target, "sentinel"), "preserve");
        symlinkSync(target, child);
      }
      expectWorkerError(invokeQuarantineWorker("prepare-raw", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: "tx-invalid-layout",
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
      expect(existsSync(child)).toBe(true);
      if (kind === "file") expect(readFileSync(child, "utf8")).toBe("foreign-file");
    },
  );

  it("detects and preserves a run-root replacement during bootstrap", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const runRoot = join(f.quarantineRoot, "tx-layout-replacement");
    expectWorkerError(invokeQuarantineWorker("layout-replacement", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-layout-replacement",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
    expect(existsSync(runRoot)).toBe(true);
    expect(existsSync(`${runRoot}.owned`)).toBe(true);
  });

  it("fails closed when either discovery pass observes workspace drift", async () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const result = invokeQuarantineWorker("drift", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: "tx-drift",
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
    });
    expectWorkerError(result, "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readdirSync(f.quarantineRoot)).toEqual([]);
  });

  it("revalidates and compares both root identities for each discovery pass", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    expectWorkerError(invokeQuarantineWorker("root-replacement", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(join(f.quarantineRoot, "replacement-sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(`${f.quarantineRoot}.owned`)).toBe(true);
  });

  it("accepts an exact Git top-level path containing an interior newline", () => {
    const f = createQuarantineFixture({ repoName: "repo\nwith-newline" });
    bases.push(f.base);
    const worker = invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "INSPECTED", head: f.head });
  });

  it.each([
    ["branch mismatch", { expectedBranch: "other-branch" }, "ERR_PREFLIGHT"],
    ["head mismatch", { expectedHead: "0".repeat(40) }, "ERR_PREFLIGHT"],
    ["count mismatch", { expectedCount: 0 }, "ERR_PREFLIGHT"],
    ["count overflow", { expectedCount: 10_000 }, "ERR_USAGE"],
    ["uppercase head", { expectedHead: "A".repeat(40) }, "ERR_USAGE"],
    ["branch NUL", { expectedBranch: "bad\0branch" }, "ERR_USAGE"],
    ["relative repository", { repoRoot: "relative/repo" }, "ERR_USAGE"],
    ["relative quarantine", { quarantineRoot: "relative/quarantine" }, "ERR_USAGE"],
  ] as Array<[string, Record<string, unknown>, string]>)(
    "rejects identity option case %s",
    (_label, override, code) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      expectWorkerError(invokeQuarantineWorker("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        ...override,
      }), code, code === "ERR_USAGE" ? "Invalid quarantine request." : "Workspace preflight failed.");
    },
  );

  it("rejects detached HEAD even when the caller names HEAD", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    git(f.repoRoot, "checkout", "--detach", f.head);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: "HEAD",
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("rejects a quarantine root contained by the repository", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const contained = join(f.repoRoot, ".contained-quarantine");
    privateDirectory(contained);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: contained,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each(["missing", "file", "symlink"] as const)(
    "rejects generated root case %s",
    (kind) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const generated = join(f.repoRoot, ".next");
      rmSync(generated, { recursive: true, force: true });
      if (kind === "file") writeFileSync(generated, "not a directory");
      if (kind === "symlink") {
        const target = join(f.base, "external-generated");
        privateDirectory(target);
        writeFileSync(join(target, "sentinel"), "preserve");
        symlinkSync(target, generated);
      }
      expectWorkerError(invokeQuarantineWorker("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it.each(["source", "canonical"] as const)("rejects a %s file symlink", (kind) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const external = join(f.base, `external-${kind}.txt`);
    writeFileSync(external, "preserve");
    if (kind === "source") {
      rmSync(join(f.repoRoot, "notes 2.txt"));
      symlinkSync(external, join(f.repoRoot, "notes 2.txt"));
    } else {
      rmSync(join(f.repoRoot, "notes.txt"));
      symlinkSync(external, join(f.repoRoot, "notes.txt"));
      git(f.repoRoot, "add", "notes.txt");
      git(f.repoRoot, "commit", "-m", "canonical symlink");
      f.head = git(f.repoRoot, "rev-parse", "HEAD");
    }
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(external, "utf8")).toBe("preserve");
  });

  it("rejects a repository-root symlink without touching its target", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const owned = `${f.repoRoot}-owned`;
    renameSync(f.repoRoot, owned);
    writeFileSync(join(owned, "root-symlink-sentinel"), "preserve");
    symlinkSync(owned, f.repoRoot);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(join(owned, "root-symlink-sentinel"), "utf8")).toBe("preserve");
  });

  it("rejects a symlinked repository ancestor without touching its target", () => {
    const f = createQuarantineFixture({ repoName: "nested/repo" });
    bases.push(f.base);
    const ancestor = join(f.base, "nested");
    const owned = join(f.base, "nested-owned");
    renameSync(ancestor, owned);
    writeFileSync(join(owned, "ancestor-symlink-sentinel"), "preserve");
    symlinkSync(owned, ancestor);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: join(ancestor, "repo"),
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(join(owned, "ancestor-symlink-sentinel"), "utf8")).toBe("preserve");
  });

  it.each(["source", "canonical"] as const)(
    "rejects same-content %s inode drift between complete passes",
    (kind) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      expectWorkerError(invokeQuarantineWorker("file-identity-drift", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        driftKind: kind,
      }), "ERR_PREFLIGHT", "Workspace preflight failed.");
      const owned = `${f.quarantineRoot}.${kind}-owned`;
      expect(existsSync(owned)).toBe(true);
      expect(readFileSync(owned, "utf8")).toBe("canonical\n");
      expect(readFileSync(join(f.repoRoot, kind === "canonical" ? "notes.txt" : "notes 2.txt"), "utf8"))
        .toBe("canonical\n");
    },
  );

  it("rejects generated-root identity drift between complete passes", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    expectWorkerError(invokeQuarantineWorker("generated-drift", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each(["branch", "head", "status"] as const)(
    "rejects %s drift observed by repeated Git snapshots",
    (target) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const bin = join(f.base, `git-drift-${target}`);
      privateDirectory(bin);
      const counter = join(bin, "count");
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const expected = target === "branch"
        ? "-c core.fsmonitor=false symbolic-ref --quiet --short HEAD"
        : target === "head"
          ? "-c core.fsmonitor=false rev-parse --verify HEAD"
          : "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all";
      const trigger = target === "status" ? 2 : 3;
      const replacement = target === "branch"
        ? "printf 'other-branch\\n'"
        : target === "head"
          ? `printf '${"0".repeat(40)}\\n'`
          : "printf '?? notes 2.txt\\0?? other 2.txt\\0'";
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$*" = ${JSON.stringify(expected)} ]; then\n  count=0\n  [ ! -f ${JSON.stringify(counter)} ] || count=$(cat ${JSON.stringify(counter)})\n  count=$((count + 1))\n  printf '%s' "$count" > ${JSON.stringify(counter)}\n  if [ "$count" -eq ${trigger} ]; then ${replacement}; exit 0; fi\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(invokeQuarantineWorker("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("uses only sanitized globally fsmonitor-disabled Git children and preserves the index", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const bin = join(f.base, "bin");
    privateDirectory(bin);
    const log = join(f.base, "git-calls.log");
    const sentinel = join(f.base, "fsmonitor-called");
    const hook = join(f.base, "hostile-fsmonitor.sh");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(hook, `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexit 0\n`, { mode: 0o700 });
    chmodSync(hook, 0o700);
    git(f.repoRoot, "config", "core.fsmonitor", hook);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$GIT_OPTIONAL_LOCKS" "$GIT_NO_LAZY_FETCH" "$GIT_LITERAL_PATHSPECS" "\${UNSAFE_TEST-unset}" "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const indexPath = join(f.repoRoot, ".git", "index");
    const gitDirectory = join(f.repoRoot, ".git");
    const lockResidueBefore = listLockResidue(gitDirectory);
    const before = statSync(indexPath, { bigint: true });
    const worker = invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      UNSAFE_TEST: "must-not-reach-git",
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const after = statSync(indexPath, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
      expect(after[key]).toBe(before[key]);
    }
    expect(existsSync(sentinel)).toBe(false);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThanOrEqual(16);
    for (const call of calls) {
      const [optionalLocks, noLazyFetch, literalPathspecs, unsafe, args] = call.split("\t");
      expect([optionalLocks, noLazyFetch, literalPathspecs, unsafe]).toEqual(["0", "1", "1", "unset"]);
      expect(args.startsWith("-c core.fsmonitor=false ")).toBe(true);
    }
    expect(calls.some((call) => call.endsWith("status --porcelain=v1 -z --untracked-files=all"))).toBe(true);
    expect(existsSync(join(f.repoRoot, ".git", "index.lock"))).toBe(false);
    expect(listLockResidue(gitDirectory)).toEqual(lockResidueBefore);
  });

  it("passes the exact closed environment and argv prefix to every Git child", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "exact-git-environment");
    privateDirectory(bin);
    const log = join(f.base, "exact-git-environment.jsonl");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");\nconst child = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit", env: process.env });\nprocess.exit(child.status ?? 1);\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const path = `${bin}:${process.env.PATH ?? ""}`;
    const worker = invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, {
      PATH: path,
      GIT_ASKPASS: "/do/not/inherit",
      HTTP_PROXY: "http://do.not.inherit.invalid",
      UNSAFE_TEST: "do-not-inherit",
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const expectedKeys = [
      "PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT",
      "LANG", "LC_ALL", "LC_CTYPE",
    ].filter((key) => typeof ({ ...process.env, PATH: path } as Record<string, unknown>)[key] === "string" &&
      String(({ ...process.env, PATH: path } as Record<string, unknown>)[key]).length > 0);
    expectedKeys.push("GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH", "GIT_LITERAL_PATHSPECS");
    expectedKeys.sort();
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.length).toBeGreaterThanOrEqual(20);
    for (const record of records) {
      expect(record.argv.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
      const observedKeys = Object.keys(record.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort();
      expect(observedKeys).toEqual(expectedKeys);
      if (process.platform === "darwin") {
        expect(record.env.__CF_USER_TEXT_ENCODING).toMatch(/^0x[0-9A-F]+:0x[0-9A-F]+:0x[0-9A-F]+$/u);
      }
      expect(record.env).toMatchObject({
        GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "1",
      });
    }
  });

  it("does not invoke a remote helper when a promisor blob is unavailable", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const missingBlob = git(f.repoRoot, "rev-parse", `${f.historyHead}:notes.txt`);
    const objectPath = join(f.repoRoot, ".git", "objects", missingBlob.slice(0, 2), missingBlob.slice(2));
    expect(existsSync(objectPath)).toBe(true);
    rmSync(objectPath);
    git(f.repoRoot, "config", "extensions.partialClone", "sentinel");
    git(f.repoRoot, "config", "remote.sentinel.promisor", "true");
    git(f.repoRoot, "config", "remote.sentinel.partialclonefilter", "blob:none");
    git(f.repoRoot, "config", "remote.sentinel.url", "sentinel::missing");
    const bin = join(f.base, "remote-helper");
    privateDirectory(bin);
    const sentinel = join(f.base, "remote-helper-called");
    writeFileSync(
      join(bin, "git-remote-sentinel"),
      `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexit 9\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git-remote-sentinel"), 0o700);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    ["missing-final-nul", Buffer.from("?? notes 2.txt", "utf8")],
    ["empty-interior-frame", Buffer.from("?? notes 2.txt\0\0", "utf8")],
    ["fatal-utf8", Buffer.from([0xff, 0x00])],
    ["tracked", Buffer.from(" M notes.txt\0", "utf8")],
    ["staged", Buffer.from("M  notes.txt\0", "utf8")],
    ["rename", Buffer.from("R  notes.txt\0notes 2.txt\0", "utf8")],
    ["unrelated", Buffer.from("?? unrelated.txt\0", "utf8")],
    ["suffix-one", Buffer.from("?? notes 1.txt\0", "utf8")],
    ["parent-component", Buffer.from("?? dir/../notes 2.txt\0", "utf8")],
    ["backslash", Buffer.from("?? dir\\notes 2.txt\0", "utf8")],
    ["non-nfc", Buffer.from("?? cafe\u0301 2.txt\0", "utf8")],
  ] as Array<[string, Buffer]>)("rejects closed porcelain status case %s", (label, output) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      label,
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      output,
    );
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("accepts exact zero-byte porcelain status as an empty source set", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      "empty-status",
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      Buffer.alloc(0),
    );
    const worker = invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 0,
    }, { PATH: path });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ totalEntries: 2, sourceCopies: 0, generatedRoots: 2 });
  });

  it("streams a valid 9999-record porcelain status larger than one MiB", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const paths = Array.from({ length: 9999 }, (_, index) =>
      `virtual-${String(index).padStart(4, "0")}-${"x".repeat(100)} 2.txt`);
    const status = Buffer.from(`${paths.map((path) => `?? ${path}`).join("\0")}\0`, "utf8");
    expect(status.length).toBeGreaterThan(1024 * 1024);
    const path = installGitOutputOverride(
      f,
      "large-valid-status",
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      status,
    );
    const worker = invokeQuarantineWorker("virtual-files", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: paths.length,
    }, { PATH: path }, 60_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({
      status: "INSPECTED", totalEntries: 10_001, sourceCopies: 9999, generatedRoots: 2,
    });
  });

  it("accepts a status record whose body including the prefix is exactly one MiB", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const fixed = "virtual-" + " 2.txt";
    const pathRecord = `virtual-${"x".repeat(STATUS_RECORD_LIMIT - 3 - fixed.length)} 2.txt`;
    const record = Buffer.from(`?? ${pathRecord}`, "utf8");
    expect(record.length).toBe(STATUS_RECORD_LIMIT);
    const path = installGitOutputOverride(
      f,
      "status-record-exact-boundary",
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      Buffer.concat([record, Buffer.from([0])]),
    );
    const worker = invokeQuarantineWorker("virtual-files", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "INSPECTED", sourceCopies: 1 });
  });

  it("kills and settles status on byte 1,048,577 before a record NUL", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const bin = join(f.base, "status-record-overflow");
    privateDirectory(bin);
    const payload = join(bin, "payload.bin");
    const body = Buffer.concat([
      Buffer.from("?? ", "utf8"),
      Buffer.alloc(STATUS_RECORD_LIMIT - 2, 0x61),
    ]);
    expect(body.length).toBe(STATUS_RECORD_LIMIT + 1);
    writeFileSync(payload, body);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all" ]; then\n  /bin/cat ${JSON.stringify(payload)}\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each(["stdout", "stderr"] as const)(
    "kills and settles a Git child after the %s control limit is exceeded",
    (stream) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const bin = join(f.base, `overflow-${stream}`);
      privateDirectory(bin);
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const redirect = stream === "stderr" ? " >&2" : "";
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false rev-parse --show-toplevel" ]; then\n  while :; do printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'${redirect}; done\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);

      expectWorkerError(invokeQuarantineWorker("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("parses and rejects an invalid history OID before a hanging log child exits", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "invalid-history");
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt" ]; then\n  printf 'bad\\0'\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["missing-final-nul", Buffer.from("a".repeat(40), "utf8")],
    ["empty-interior", Buffer.from(`${"a".repeat(40)}\0\0`, "utf8")],
    ["fatal-utf8", Buffer.from([0xff, 0x00])],
  ] as Array<[string, Buffer]>)("rejects incremental history log case %s", (label, output) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      `history-${label}`,
      "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt",
      output,
    );
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("accepts an exact 64-byte lowercase history OID body plus NUL", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-64-byte-body");
    privateDirectory(bin);
    const commitOid = "a".repeat(HISTORY_OID_BODY_LIMIT);
    const blobOid = "b".repeat(HISTORY_OID_BODY_LIMIT);
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    writeFileSync(logPayload, Buffer.from(`${commitOid}\0`, "utf8"));
    writeFileSync(treePayload, Buffer.from(`100644 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${commitOid} -- notes.txt") exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-history-64-byte-body",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(commitOid);
  });

  it("kills and settles history on a 65th OID body byte before NUL", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-65-byte-body");
    privateDirectory(bin);
    const payload = join(bin, "payload.bin");
    writeFileSync(payload, Buffer.alloc(HISTORY_OID_BODY_LIMIT + 1, 0x61));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt" ]; then\n  /bin/cat ${JSON.stringify(payload)}\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("retains duplicate history OIDs in their emitted order", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "duplicate-history-order");
    privateDirectory(bin);
    const first = "a".repeat(40);
    const matching = "b".repeat(40);
    const blobOid = "c".repeat(40);
    const calls = join(bin, "ls-tree-calls");
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    writeFileSync(logPayload, Buffer.from(`${first}\0${first}\0${matching}\0`, "utf8"));
    writeFileSync(treePayload, Buffer.from(`100644 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${first} -- notes.txt") printf '%s\\n' ${JSON.stringify(first)} >> ${JSON.stringify(calls)}; exit 0 ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${matching} -- notes.txt") printf '%s\\n' ${JSON.stringify(matching)} >> ${JSON.stringify(calls)}; exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-duplicate-order",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      first, first, matching, first, first, matching,
    ]);
  });

  it("retains exactly 4096 unique history OIDs in emitted order", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-boundary");
    privateDirectory(bin);
    const commits = Array.from({ length: HISTORY_FRAME_LIMIT }, (_, index) =>
      index.toString(16).padStart(HISTORY_OID_BODY_LIMIT, "0"));
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    const blobOid = "b".repeat(HISTORY_OID_BODY_LIMIT);
    const historyBody = Buffer.from(`${commits.join("\0")}\0`, "utf8");
    expect(historyBody.length).toBe(HISTORY_FRAME_LIMIT * (HISTORY_OID_BODY_LIMIT + 1));
    writeFileSync(logPayload, historyBody);
    writeFileSync(treePayload, Buffer.from(`100644 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${commits[0]} -- notes.txt") exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-history-boundary",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(commits[0]);
  });

  it("kills and settles history on a 4,097th complete OID frame", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-frame-overflow");
    privateDirectory(bin);
    const payload = join(bin, "payload.bin");
    const oid = "a".repeat(HISTORY_OID_BODY_LIMIT);
    const historyBody = Buffer.from(`${Array(HISTORY_FRAME_LIMIT + 1).fill(oid).join("\0")}\0`, "utf8");
    expect(historyBody.length).toBe((HISTORY_FRAME_LIMIT + 1) * (HISTORY_OID_BODY_LIMIT + 1));
    writeFileSync(payload, historyBody);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt" ]; then\n  /bin/cat ${JSON.stringify(payload)}\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["bad-mode-type", `100644 tree ${"a".repeat(40)}\tnotes.txt\0`],
    ["bad-mode-width", `10064 blob ${"a".repeat(40)}\tnotes.txt\0`],
    ["bad-tree-pair", `040000 blob ${"a".repeat(40)}\tnotes.txt\0`],
    ["uppercase-oid", `100644 blob ${"A".repeat(40)}\tnotes.txt\0`],
    ["mismatched-path", `100644 blob ${"a".repeat(40)}\tother.txt\0`],
    ["missing-nul", `100644 blob ${"a".repeat(40)}\tnotes.txt`],
    ["multiple", `100644 blob ${"a".repeat(40)}\tnotes.txt\0` +
      `100644 blob ${"b".repeat(40)}\tnotes.txt\0`],
  ] as Array<[string, string]>)("rejects ls-tree control case %s", (label, output) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const commit = git(f.repoRoot, "log", "--all", "--format=%H", "--", "notes.txt").split("\n")[0];
    const path = installGitOutputOverride(
      f,
      `ls-tree-${label}`,
      `-c core.fsmonitor=false ls-tree -z --full-tree ${commit} -- notes.txt`,
      Buffer.from(output, "utf8"),
    );
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["exact-one-mib", 1024 * 1024],
    ["one-byte-over", 1024 * 1024 + 1],
  ] as Array<[string, number]>)("rejects malformed ls-tree control payload at %s", (label, size) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const commit = git(f.repoRoot, "log", "--all", "--format=%H", "--", "notes.txt").split("\n")[0];
    const path = installGitOutputOverride(
      f,
      `ls-tree-control-${label}`,
      `-c core.fsmonitor=false ls-tree -z --full-tree ${commit} -- notes.txt`,
      Buffer.alloc(size, 0x61),
    );
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }, 3_000), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("treats exact zero-byte ls-tree output as a skipped history candidate", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "empty-ls-tree");
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false ls-tree -z --full-tree"*) exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-empty-ls-tree",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBeNull();
  });

  it.each(["nonzero", "oversized"] as const)(
    "settles and rejects an ls-tree child with %s output",
    (kind) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const bin = join(f.base, `ls-tree-${kind}`);
      privateDirectory(bin);
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const action = kind === "nonzero"
        ? "printf 'failure' >&2; exit 9"
        : "while :; do printf '0123456789abcdef0123456789abcdef'; done";
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false ls-tree -z --full-tree"*) ${action} ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(invokeQuarantineWorker("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it.each([
    ["040000", "tree"],
    ["120000", "blob"],
    ["160000", "commit"],
  ] as Array<[string, string]>)("skips the exact nonregular ls-tree pair %s %s", (mode, type) => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, `skip-${mode}`);
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const catSentinel = join(f.base, `cat-${mode}`);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false ls-tree -z --full-tree"*) printf '${mode} ${type} ${"a".repeat(40)}\\tnotes.txt\\0'; exit 0 ;;\n  "-c core.fsmonitor=false cat-file blob"*) : > ${JSON.stringify(catSentinel)}; exit 9 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-skip-${mode}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBeNull();
    expect(existsSync(catSentinel)).toBe(false);
  });

  it("handles newline and pathspec punctuation as one literal history argument", () => {
    const canonicalPath = "dir\nline/lit[*].ts";
    const copyPath = "dir\nline/lit[*] 2.ts";
    const f = createQuarantineFixture({ divergent: true, canonicalPath, copyPath });
    bases.push(f.base);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-literal-pathspec",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(f.historyHead);
  });

  it.each(["log", "ls-tree", "cat-file"] as const)(
    "settles and sanitizes a signaled history %s child",
    (target) => {
      const f = createQuarantineFixture({ divergent: true });
      bases.push(f.base);
      const commit = git(f.repoRoot, "log", "--all", "--format=%H", "--", "notes.txt").split("\n")[0];
      const tree = git(f.repoRoot, "ls-tree", commit, "--", "notes.txt").split(/\s+/u);
      const blobOid = tree[2];
      const expected = target === "log"
        ? "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt"
        : target === "ls-tree"
          ? `-c core.fsmonitor=false ls-tree -z --full-tree ${commit} -- notes.txt`
          : `-c core.fsmonitor=false cat-file blob ${blobOid}`;
      const bin = join(f.base, `signal-${target}`);
      privateDirectory(bin);
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$*" = ${JSON.stringify(expected)} ]; then kill -TERM $$; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(invokeQuarantineWorker("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("kills and settles a cat-file child after its stderr limit is exceeded", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "cat-stderr-overflow");
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false cat-file blob"*) while :; do printf '0123456789abcdef0123456789abcdef' >&2; done ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("streams a multi-megabyte cat-file blob through the exact 64 KiB child pipe", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const largeBody = Buffer.alloc(2 * 1024 * 1024 + 17, 0x78);
    writeFileSync(join(f.repoRoot, "notes.txt"), largeBody);
    git(f.repoRoot, "add", "notes.txt");
    git(f.repoRoot, "commit", "-m", "large canonical history");
    const largeCommit = git(f.repoRoot, "rev-parse", "HEAD");
    writeFileSync(join(f.repoRoot, "notes.txt"), "new canonical\n");
    git(f.repoRoot, "add", "notes.txt");
    git(f.repoRoot, "commit", "-m", "replace large canonical");
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    writeFileSync(join(f.repoRoot, "notes 2.txt"), largeBody);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-large-cat-file",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(largeCommit);
  });

  it("accepts an exact 100755 blob and stores the candidate commit OID", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "eligible-executable");
    privateDirectory(bin);
    const commitOid = "c".repeat(40);
    const blobOid = "d".repeat(40);
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    writeFileSync(logPayload, Buffer.from(`${commitOid}\0`, "utf8"));
    writeFileSync(treePayload, Buffer.from(`100755 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${commitOid} -- notes.txt") exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-executable",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(commitOid);
  });

  it("captures every filesystem getter and receiver once", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("fs-capture", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.counts).toEqual(Object.fromEntries(FS_METHODS.map((method) => [method, 1])));
    expect(worker.wrongReceiver).toBe(0);
  });

  it("rejects a missing filesystem method before discovery", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    expectWorkerError(invokeQuarantineWorker("missing-fs-method", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_USAGE", "Invalid quarantine request.");
  });

  it("is unaffected by source adapter mutation after all getters are captured", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("fs-late-mutation", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "INSPECTED", totalEntries: 3 });
  });

  it("persists only the matching historical commit OID for a divergent source", () => {
    const f = createQuarantineFixture({ divergent: true });
    bases.push(f.base);
    const worker = invokeQuarantineWorker("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-history",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.classification).toBe("divergent");
    expect(source.historyMatch).toBe(f.historyHead);
    expect(source.historyMatch).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("maps mode and device failures and propagates the layout hook unchanged", () => {
    const modeFixture = createQuarantineFixture();
    bases.push(modeFixture.base);
    chmodSync(modeFixture.quarantineRoot, 0o755);
    expectWorkerError(invokeQuarantineWorker("inspect", {
      repoRoot: modeFixture.repoRoot,
      quarantineRoot: modeFixture.quarantineRoot,
      expectedBranch: modeFixture.branch,
      expectedHead: modeFixture.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");

    const deviceFixture = createQuarantineFixture();
    bases.push(deviceFixture.base);
    expectWorkerError(invokeQuarantineWorker("device", {
      repoRoot: deviceFixture.repoRoot,
      quarantineRoot: deviceFixture.quarantineRoot,
      expectedBranch: deviceFixture.branch,
      expectedHead: deviceFixture.head,
      expectedCount: 1,
    }), "ERR_EXDEV", "Repository and quarantine must be on the same filesystem.");

    const hookFixture = createQuarantineFixture();
    bases.push(hookFixture.base);
    const hookResult = invokeQuarantineWorker("hook-error", {
      repoRoot: hookFixture.repoRoot,
      quarantineRoot: hookFixture.quarantineRoot,
      expectedBranch: hookFixture.branch,
      expectedHead: hookFixture.head,
      expectedCount: 1,
      transactionId: "tx-hook",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(hookResult).toMatchObject({
      ok: false,
      error: { name: "RangeError", message: "injected hook failure", frozen: false },
    });
  });

  it("propagates hook throw undefined only after the hook was actually invoked", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("hook-sentinel", {
      variant: "hook-undefined",
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-hook-undefined",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker).toMatchObject({ ok: false, hookCalls: 1, thrownUndefined: true });
    expect(worker.error).toBeUndefined();
  });

  it("sanitizes a pre-hook internal throw undefined without invoking the hook", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("hook-sentinel", {
      variant: "prehook-undefined",
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-prehook-undefined",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker).toMatchObject({ hookCalls: 0, thrownUndefined: false });
    expectWorkerError(worker, "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["stateful", "ERR_EXDEV", "Repository and quarantine must be on the same filesystem."],
    ["throw", "ERR_PREFLIGHT", "Workspace preflight failed."],
  ] as const)("snapshots a %s mkdir error code exactly once", (variant, code, message) => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    const worker = invokeQuarantineWorker("mkdir-error-code", {
      variant,
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-mkdir-code-${variant}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker.codeReads).toBe(1);
    expectWorkerError(worker, code, message);
  });

  it.each(["close-reject", "sync-reject"] as const)(
    "captures and invokes directory close exactly once for %s",
    (variant) => {
      const f = createQuarantineFixture();
      bases.push(f.base);
      const worker = invokeQuarantineWorker("sync-close-lifecycle", {
        variant,
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: `tx-sync-close-${variant}`,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      });
      expect(worker).toMatchObject({
        closeGetterReads: 1,
        closeCalls: 1,
        closeWrongReceiver: 0,
      });
      expectWorkerError(worker, "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("rejects a non-safe source mode instead of framing a coerced value", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    expectWorkerError(invokeQuarantineWorker("invalid-source-mode", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("rejects unknown symbol option keys before discovery", () => {
    const f = createQuarantineFixture();
    bases.push(f.base);
    expectWorkerError(invokeQuarantineWorker("symbol", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_USAGE", "Invalid quarantine request.");
  });
});
