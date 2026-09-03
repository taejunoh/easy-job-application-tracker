import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const root = join(__dirname, "../..");
const script = join(root, "scripts/compare-application-identity-reports.mjs");
const privateValue = "private-application-content-never-print";

type Report = {
  schemaVersion: number;
  mode: "dry-run" | "apply";
  rowCountBefore: number;
  rowCountAfter: number;
  stateTotals: {
    canonical: number;
    legacy_duplicate: number;
    legacy_unresolved: number;
  };
  uniqueIndexVerified: boolean;
  rows: Array<{
    rowIdHash: string;
    state: "canonical" | "legacy_duplicate" | "legacy_unresolved";
    duplicateOfIdHash?: string;
  }>;
};

type CliResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;

async function runComparator(arguments_: readonly string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [script, ...arguments_], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

async function writeReport(directory: string, name: string, report: unknown): Promise<string> {
  const path = join(directory, name);
  expect(isAbsolute(path)).toBe(true);
  await writeFile(path, JSON.stringify(report), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function writeRawReport(directory: string, name: string, content: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function report(mode: "dry-run" | "apply" = "dry-run"): Report {
  return {
    schemaVersion: 1,
    mode,
    rowCountBefore: 3,
    rowCountAfter: 3,
    stateTotals: { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 },
    uniqueIndexVerified: true,
    rows: [
      { rowIdHash: "a".repeat(64), state: "canonical" },
      {
        rowIdHash: "b".repeat(64),
        state: "legacy_duplicate",
        duplicateOfIdHash: "a".repeat(64),
      },
      { rowIdHash: "c".repeat(64), state: "legacy_unresolved" },
    ],
  };
}

function expectFailure(result: CliResult): void {
  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "Application identity report comparison failed.\n",
  });
  expect(`${result.stdout}${result.stderr}`).not.toContain(privateValue);
}

describe("application identity report comparator", () => {
  it.each(["dry-run", "apply"] as const)("accepts identical invariant data for actual %s", async (actualMode) => {
    const directory = await mkdtemp(join(tmpdir(), "identity-report-comparator-"));
    const expected = await writeReport(directory, "expected.json", report());
    const actual = await writeReport(directory, "actual.json", report(actualMode));

    await expect(runComparator(["--expected", expected, "--actual", actual, "--actual-mode", actualMode]))
      .resolves.toEqual({ code: 0, stdout: "Application identity reports match.\n", stderr: "" });
  });

  it.each([
    ["changed row count", (value: Report) => ({ ...value, rowCountBefore: 4, rowCountAfter: 4, stateTotals: { canonical: 2, legacy_duplicate: 1, legacy_unresolved: 1 }, rows: [...value.rows, { rowIdHash: "d".repeat(64), state: "canonical" as const }] })],
    ["changed state totals", (value: Report) => ({ ...value, stateTotals: { canonical: 2, legacy_duplicate: 0, legacy_unresolved: 1 }, rows: [{ ...value.rows[0] }, { rowIdHash: "b".repeat(64), state: "canonical" as const }, { ...value.rows[2] }] })],
    ["unverified unique index", (value: Report) => ({ ...value, uniqueIndexVerified: false })],
    ["changed duplicate assignment", (value: Report) => ({ ...value, rows: [{ ...value.rows[0] }, { ...value.rows[1], duplicateOfIdHash: "c".repeat(64) }, { ...value.rows[2] }] })],
  ])("rejects %s", async (_, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), "identity-report-comparator-"));
    const expected = await writeReport(directory, "expected.json", report());
    const actual = await writeReport(directory, "actual.json", mutate(report()));

    expectFailure(await runComparator(["--expected", expected, "--actual", actual, "--actual-mode", "dry-run"]));
  });

  it.each([
    ["missing expected file", async (directory: string) => [join(directory, "missing.json"), await writeReport(directory, "actual.json", report()), "dry-run"]],
    ["missing actual file", async (directory: string) => [await writeReport(directory, "expected.json", report()), join(directory, "missing.json"), "dry-run"]],
    ["malformed JSON", async (directory: string) => [await writeReport(directory, "expected.json", report()), await writeRawReport(directory, "actual.json", `{\"${privateValue}\"`), "dry-run"]],
    ["wrong schema version", async (directory: string) => [await writeReport(directory, "expected.json", { ...report(), schemaVersion: 2 }), await writeReport(directory, "actual.json", report()), "dry-run"]],
    ["expected apply report", async (directory: string) => [await writeReport(directory, "expected.json", report("apply")), await writeReport(directory, "actual.json", report()), "dry-run"]],
    ["actual mode differs from argument", async (directory: string) => [await writeReport(directory, "expected.json", report()), await writeReport(directory, "actual.json", report("apply")), "dry-run"]],
    ["extra raw report key", async (directory: string) => [await writeReport(directory, "expected.json", { ...report(), rawUrl: privateValue }), await writeReport(directory, "actual.json", report()), "dry-run"]],
    ["extra raw row key", async (directory: string) => [await writeReport(directory, "expected.json", report()), await writeReport(directory, "actual.json", { ...report(), rows: [{ ...report().rows[0], sourceUrl: privateValue }, ...report().rows.slice(1)] }), "dry-run"]],
  ])("fails safely for %s", async (_, prepare) => {
    const directory = await mkdtemp(join(tmpdir(), "identity-report-comparator-"));
    const [expected, actual, actualMode] = await prepare(directory);
    expectFailure(await runComparator(["--expected", expected, "--actual", actual, "--actual-mode", actualMode]));
  });

  it.each([
    ["duplicate expected flag", ["--expected", "/tmp/one.json", "--expected", "/tmp/two.json", "--actual", "/tmp/actual.json", "--actual-mode", "dry-run"]],
    ["duplicate actual flag", ["--expected", "/tmp/expected.json", "--actual", "/tmp/one.json", "--actual", "/tmp/two.json", "--actual-mode", "dry-run"]],
    ["duplicate actual mode flag", ["--expected", "/tmp/expected.json", "--actual", "/tmp/actual.json", "--actual-mode", "dry-run", "--actual-mode", "apply"]],
    ["relative expected path", ["--expected", "expected.json", "--actual", "/tmp/actual.json", "--actual-mode", "dry-run"]],
    ["relative actual path", ["--expected", "/tmp/expected.json", "--actual", "actual.json", "--actual-mode", "dry-run"]],
    ["unknown flag", ["--expected", "/tmp/expected.json", "--actual", "/tmp/actual.json", "--actual-mode", "dry-run", "--raw-content", privateValue]],
    ["missing expected flag", ["--actual", "/tmp/actual.json", "--actual-mode", "dry-run"]],
    ["missing actual flag", ["--expected", "/tmp/expected.json", "--actual-mode", "dry-run"]],
    ["missing actual mode flag", ["--expected", "/tmp/expected.json", "--actual", "/tmp/actual.json"]],
    ["invalid actual mode", ["--expected", "/tmp/expected.json", "--actual", "/tmp/actual.json", "--actual-mode", "preview"]],
    ["flag value mistaken for flag", ["--expected", "--actual", "/tmp/actual.json", "--actual-mode", "dry-run"]],
  ])("rejects %s", async (_, arguments_) => {
    expectFailure(await runComparator(arguments_));
  });
});
