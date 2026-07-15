import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-inventory.mjs")).href;

type InventorySummary = Readonly<{ sha256: string; entries: number; bytes: number }>;

function runWorker(request: Record<string, unknown>) {
  const source = `
import * as inventory from ${JSON.stringify(moduleUrl)};
import * as fsPromises from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let peakRssBytes = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 2);
try {
  if (global.gc) global.gc();
  let result;
  if (request.operation === "two-passes") {
    const fsApi = {
      ...fsPromises,
      readFile: async () => { throw new Error("payload readFile is forbidden"); },
    };
    const first = await inventory.writeInventoryJsonl({
      root: request.root,
      outputPath: request.firstOutput,
      fsApi,
    });
    const second = await inventory.writeInventoryJsonl({
      root: request.root,
      outputPath: request.secondOutput,
      fsApi,
    });
    result = { first, second };
  } else if (request.operation === "hash") {
    result = await inventory.hashFileStream(request.path);
  } else if (request.operation === "compare") {
    result = await inventory.compareInventorySummary(request.expected, request.observed);
  }
  if (global.gc) global.gc();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  process.stdout.write(JSON.stringify({ ok: true, result, peakRssBytes }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, peakRssBytes }));
} finally {
  clearInterval(sampler);
}
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify(request),
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("streaming quarantine inventory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-inventory-"));
  const root = join(fixture, "payload");
  const leafDirectory = join(root, "files", "nested");
  const firstOutput = join(fixture, "inventory-first.jsonl");
  const secondOutput = join(fixture, "inventory-second.jsonl");
  let workerResult: {
    result: { first: InventorySummary; second: InventorySummary };
    peakRssBytes: number;
  };

  beforeAll(() => {
    mkdirSync(leafDirectory, { recursive: true });
    for (let index = 0; index < 40_000; index += 1) {
      const name = `file-${index.toString().padStart(5, "0")}.txt`;
      writeFileSync(join(leafDirectory, name), "x");
    }
    chmodSync(join(leafDirectory, "file-00000.txt"), 0o640);
    symlinkSync("../../../outside-must-not-be-followed", join(leafDirectory, "leaf-link"));

    workerResult = runWorker({
      operation: "two-passes",
      root,
      firstOutput,
      secondOutput,
    });
  }, 120_000);

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it("writes deterministic bytewise-sorted JSONL with a manifest-sized summary", () => {
    expect(workerResult.result.second).toEqual(workerResult.result.first);
    expect(workerResult.result.second).toMatchObject({ entries: 40_003, bytes: 40_037 });
    expect(Object.keys(workerResult.result.second).sort()).toEqual(["bytes", "entries", "sha256"]);
    expect(workerResult.result.second.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const first = readFileSync(firstOutput, "utf8");
    const second = readFileSync(secondOutput, "utf8");
    expect(second).toBe(first);
    const records = second.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(40_003);
    expect(records[0]).toMatchObject({ path: "files", type: "directory" });
    const paths = records.map((record) => record.path);
    const sortedPaths = [...paths].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    expect(paths).toEqual(sortedPaths);
  });

  it("records mode, type, size, hashes, and a no-follow symlink target", () => {
    const records = readFileSync(secondOutput, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const file = records.find((record) => record.path.endsWith("file-00000.txt"));
    expect(file).toEqual({
      path: "files/nested/file-00000.txt",
      type: "file",
      mode: 0o640,
      size: 1,
      sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    });
    const link = records.find((record) => record.path.endsWith("leaf-link"));
    expect(link).toEqual({
      path: "files/nested/leaf-link",
      type: "symlink",
      mode: lstatSync(join(leafDirectory, "leaf-link")).mode & 0o7777,
      size: 37,
      linkTarget: "../../../outside-must-not-be-followed",
    });
    expect(records.some((record) => record.path.includes("outside-must-not-be-followed/"))).toBe(
      false,
    );
  });

  it("creates mode-0600 output without loading payload bodies through readFile", () => {
    expect(lstatSync(firstOutput).mode & 0o777).toBe(0o600);
    expect(lstatSync(secondOutput).mode & 0o777).toBe(0o600);
  });

  it("keeps the worker peak RSS below 160 MiB", () => {
    expect(workerResult.peakRssBytes).toBeLessThan(160 * 1024 * 1024);
  });

  it("hashes regular files incrementally and compares exact summaries", () => {
    const result = runWorker({ operation: "hash", path: join(leafDirectory, "file-00001.txt") });
    expect(result.result).toEqual({
      sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      bytes: 1,
    });
    expect(
      runWorker({
        operation: "compare",
        expected: workerResult.result.first,
        observed: workerResult.result.second,
      }).result,
    ).toBe(true);
    expect(() =>
      runWorker({
        operation: "compare",
        expected: workerResult.result.first,
        observed: { ...workerResult.result.second, entries: 1 },
      }),
    ).toThrow(/summary/u);
  });
});
