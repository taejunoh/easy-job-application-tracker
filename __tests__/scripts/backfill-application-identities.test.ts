import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildApplicationIdentityPlan,
  createPrivacySafeReport,
  parseBackfillArguments,
  writeBackfillReport,
} from "@/lib/applications/backfill";

const rows = [
  row("00000000-0000-4000-8000-000000000003", "2026-01-02T00:00:00.000Z", "not a url"),
  row("00000000-0000-4000-8000-000000000002", "2026-01-01T00:00:00.000Z", "https://example.test/jobs/1?utm_source=feed"),
  row("00000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000Z", "https://example.test/jobs/1"),
  row("00000000-0000-4000-8000-000000000004", "2026-01-03T00:00:00.000Z", "https://example.test/jobs/2"),
];

describe("Application identity backfill", () => {
  it("selects deterministic winners without dropping unresolved or duplicate rows", () => {
    const plan = buildApplicationIdentityPlan(rows);

    expect(plan).toHaveLength(4);
    expect(plan.map(({ id, state, duplicateOfId }) => ({ id, state, duplicateOfId }))).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        state: "canonical",
        duplicateOfId: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        state: "legacy_duplicate",
        duplicateOfId: "00000000-0000-4000-8000-000000000001",
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        state: "legacy_unresolved",
        duplicateOfId: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        state: "canonical",
        duplicateOfId: null,
      },
    ]);
    expect(new Set(plan.map(({ id }) => id)).size).toBe(rows.length);
    expect(plan[0].identityKey).toMatch(/^url-v1:[0-9a-f]{64}$/u);
    expect(plan[1].identityKey).toBeNull();
    expect(plan[1].canonicalUrl).toBe(plan[0].canonicalUrl);
  });

  it("is idempotent when fed rows carrying the prior assignments", () => {
    const first = buildApplicationIdentityPlan(rows);
    const rerunRows = rows.map((source) => {
      const assignment = first.find(({ id }) => id === source.id);
      return { ...source, ...assignment };
    });

    expect(buildApplicationIdentityPlan(rerunRows)).toEqual(first);
  });

  it("builds a report with counts and opaque identifiers but no private row content", () => {
    const plan = buildApplicationIdentityPlan(rows);
    const report = createPrivacySafeReport({
      mode: "dry-run",
      rowCountBefore: 4,
      rowCountAfter: 4,
      uniqueIndexVerified: true,
      plan,
    });
    const serialized = JSON.stringify(report);

    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: "dry-run",
      rowCountBefore: 4,
      rowCountAfter: 4,
      stateTotals: { canonical: 2, legacy_duplicate: 1, legacy_unresolved: 1 },
      uniqueIndexVerified: true,
    });
    expect(report.rows).toHaveLength(4);
    expect(report.rows[0].rowIdHash).toMatch(/^[0-9a-f]{64}$/u);
    for (const privateValue of [
      ...rows.flatMap(({ id, url, jobTitle, company }) => [id, url, jobTitle, company]),
      "postgresql://",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("creates the report once with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "application-backfill-test-"));
    const reportPath = join(directory, "report.json");
    const report = createPrivacySafeReport({
      mode: "dry-run",
      rowCountBefore: 0,
      rowCountAfter: 0,
      uniqueIndexVerified: true,
      plan: [],
    });

    await writeBackfillReport(reportPath, report);

    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    await expect(writeBackfillReport(reportPath, report)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(reportPath, "utf8")).resolves.toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  it("requires an explicit writer-stop attestation for apply", () => {
    expect(parseBackfillArguments(["--report", "/tmp/report.json"])).toEqual({
      apply: false,
      reportPath: "/tmp/report.json",
      writersStopped: false,
    });
    expect(() =>
      parseBackfillArguments(["--apply", "--report", "/tmp/report.json"]),
    ).toThrow("--writers-stopped");
    expect(
      parseBackfillArguments([
        "--apply",
        "--writers-stopped",
        "--report",
        "/tmp/report.json",
      ]),
    ).toEqual({ apply: true, reportPath: "/tmp/report.json", writersStopped: true });
    expect(() => parseBackfillArguments(["--unknown"])).toThrow("Invalid arguments");
  });
});

function row(id: string, createdAt: string, url: string) {
  return {
    id,
    createdAt: new Date(createdAt),
    url,
    jobTitle: `Private title ${id}`,
    company: `Private company ${id}`,
  };
}
