import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const runnerUrl = pathToFileURL(join(root, "scripts/rehearse-isolated-db.mjs")).href;
const host = "ep-bitter-moon-aux0rv8i.c-10.us-east-1.aws.neon.tech";
const databaseUrl = `postgresql://neondb_owner:fake-password@${host}/neondb?sslmode=require&channel_binding=require`;
const manifest = {
  schemaVersion: 1, kind: "jobtracker-isolated-validation-manifest",
  environmentId: "4b76205d-6f41-4ed8-9b0f-2f31785a6f13",
  sourceSha: "5e5610944698e18230c8e67378dda35d8eb311f8",
  vercelProjectId: "prj_ZVWlit980NwxpRCloaqqG9nchecf",
  neonOrganizationId: "org-dawn-dust-44814444",
  database: { projectId: "raspy-wave-56679088", branchId: "br-ancient-brook-ausbwkau", endpointId: "ep-bitter-moon-aux0rv8i", host, port: 5432, database: "neondb" },
};
const deny = {
  schemaVersion: 1, kind: "jobtracker-production-deny-list",
  vercelProjectIds: ["prj-production"], neonOrganizationIds: ["org-production"],
  neonProjectIds: ["project-production"], databaseHosts: ["prod.neon.tech"],
};

async function temporary<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "isolated-db-runner-"));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function probe(input: Record<string, unknown>) {
  return temporary(async (directory) => {
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "output.json");
    const probePath = join(directory, "probe.mjs");
    await writeFile(inputPath, JSON.stringify(input));
    await writeFile(probePath, `
      import { createHash } from "node:crypto";
      import { readFile, writeFile } from "node:fs/promises";
      const input = JSON.parse(await readFile(process.argv[2], "utf8"));
      const { run, validateUrl } = await import(process.argv[3]);
      const events = [];
      const fixtures = ["isr-0001-canonical", "isr-0002-duplicate", "isr-0003-unresolved"];
      let cleanupIds = input.cleanupRows ?? fixtures;
      let fixtureIds = [];
      let inTransaction = false;
      const marker = () => ({ rows: [{ environmentId: input.manifest.environmentId, appSourceSha: input.manifest.sourceSha, runnerSha: "a".repeat(40), manifestDigest: input.markerDigest ?? createHash("sha256").update(JSON.stringify(input.manifest)).digest("hex"), fixtureIds }] });
      const client = {
        async connect() { events.push("connect"); },
        async end() { events.push("end"); },
        async query(sql, values = []) {
          events.push(sql.replace(/\\s+/g, " ").trim());
          if (input.failQuery && sql.includes(input.failQuery)) throw new Error("fake query failure");
          if (sql.includes("current_database")) return { rows: [input.identity ?? { database: "neondb", port: 5432, schema: "public", migrationTable: null, marker: null, publicRelations: input.pgNameArray ? (sql.includes("c.relname::text") ? [] : "{}") : [] }] };
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: input.lock !== false }] };
          if (sql.includes("environment_marker") && /^SELECT/.test(sql.trim())) return input.markerRows === "unknown" ? { rows: [] } : marker();
          if (sql === "BEGIN") { inTransaction = true; return { rows: [] }; }
          if (sql === "COMMIT" || sql === "ROLLBACK") { inTransaction = false; return { rows: [] }; }
          if (sql.includes('UPDATE "validation_control"."environment_marker" SET "fixtureIds"')) { fixtureIds = values[0]; return { rows: [] }; }
          if (sql.includes('SELECT count(*)::int AS count FROM "Application"')) return { rows: [{ count: input.applicationCount ?? 0 }] };
          if (sql.includes('SELECT "id","identityKey"')) return { rows: input.applicationRows ?? expectedRows };
          if (sql.includes('SELECT "id" FROM "Application"')) return { rows: cleanupIds.map((id) => ({ id })) };
          if (sql.includes('ExtensionPairingGrant')) return { rows: [{ settings: 0, installations: 0, grants: 0 }] };
          if (sql.includes('SELECT migration_name AS name')) return { rows: [{ name: "20260713000000_init" }, { name: "20260813010000_application_identity" }, { name: "20260813020000_extension_installations" }] };
          if (/^DELETE/.test(sql.trim())) { cleanupIds = cleanupIds.filter((id) => id !== values[0]); return { rows: [], rowCount: input.deleteRowCount ?? 1 }; }
          return { rows: [], rowCount: 1 };
        },
      };
      const expectedRows = [
        { id: "isr-0001-canonical", identityKey: "url-v1:1541d4212c992b23bd3f8169c924f603700a2859b187e6771b999021bff87aeb", canonicalUrl: "https://jobs.validation.example/roles/alpha", duplicateOfId: null, identityState: "canonical" },
        { id: "isr-0002-duplicate", identityKey: null, canonicalUrl: "https://jobs.validation.example/roles/alpha", duplicateOfId: "isr-0001-canonical", identityState: "legacy_duplicate" },
        { id: "isr-0003-unresolved", identityKey: null, canonicalUrl: null, duplicateOfId: null, identityState: "legacy_unresolved" },
      ];
      const reports = [
        { schemaVersion: 1, mode: "dry-run", rowCountBefore: 3, rowCountAfter: 3, stateTotals: { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 }, uniqueIndexVerified: true, rows: [] },
        { schemaVersion: 1, mode: "apply", rowCountBefore: 3, rowCountAfter: 3, stateTotals: { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 }, uniqueIndexVerified: true, rows: [] },
        { schemaVersion: 1, mode: "dry-run", rowCountBefore: 3, rowCountAfter: 3, stateTotals: { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 }, uniqueIndexVerified: true, rows: [] },
        { schemaVersion: 1, mode: "apply", rowCountBefore: 3, rowCountAfter: 3, stateTotals: { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 }, uniqueIndexVerified: true, rows: [] },
      ];
      let reportIndex = 0;
      try {
        if (input.validateOnly) { const result = validateUrl(input.databaseUrl, input.manifest, input.deny); await writeFile(process.argv[4], JSON.stringify({ ok: true, result, events })); }
        else {
          await run({ manifest: input.manifest, deny: input.deny, databaseUrl: input.databaseUrl, sourceRoot: "/approved/source", artifacts: "/approved/artifacts", runnerSha: "a".repeat(40), client,
          assertSource: async () => { events.push("source"); if (input.sourceFailure) throw new Error("source failure"); }, reserveReports: async () => events.push("reserve"),
          exec: async (_file, args) => { events.push("exec:" + args.join(" ")); if (input.failExec && args.join(" ").includes(input.failExec)) throw new Error("fake child failure"); },
          readReport: async () => input.badReport ? { ...reports[reportIndex++], mode: "bad" } : reports[reportIndex++],
            writeSummary: async (summary) => { events.push("summary:" + summary.cleanup); },
          });
          await writeFile(process.argv[4], JSON.stringify({ ok: true, events, inTransaction }));
        }
      } catch (error) { await writeFile(process.argv[4], JSON.stringify({ ok: false, message: error.message, events, inTransaction })); }
    `);
    await execFile("/Users/taejunoh/.nvm/versions/node/v22.22.2/bin/node", [probePath, inputPath, runnerUrl, outputPath]);
    return JSON.parse(await (await import("node:fs/promises")).readFile(outputPath, "utf8"));
  });
}

async function sourceProbe(kind: "missing" | "symlink" | "env" | "example" | "wrong-sha" | "dirty") {
  return temporary(async (directory) => {
    const source = join(directory, "source");
    const output = join(directory, "output.json");
    const harness = join(directory, "source-probe.mjs");
    const required = ["package.json", "package-lock.json", "prisma.config.ts", "prisma/schema.prisma", "prisma/migrations/migration_lock.toml", "scripts/backfill-application-identities.mjs", "src/lib/applications/backfill.ts", "src/lib/applications/identity.ts"];
    for (const path of required) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), "fixture\n");
    }
    if (kind === "missing") await rm(join(source, "src/lib/applications/identity.ts"));
    if (kind === "symlink") {
      const target = join(directory, "outside.ts");
      await writeFile(target, "outside\n");
      await rm(join(source, "src/lib/applications/identity.ts"));
      await symlink(target, join(source, "src/lib/applications/identity.ts"));
    }
    if (kind === "env") await writeFile(join(source, ".env.local"), "not-a-secret\n");
    if (kind === "example") await writeFile(join(source, ".env.example"), "non-secret-template\n");
    await writeFile(harness, `
      import { writeFile } from "node:fs/promises";
      const { assertSource } = await import(process.argv[2]);
      const events = [];
      const git = async (_command, args) => ({ stdout: args.includes("rev-parse") ? (process.argv[5] === "wrong-sha" ? "f".repeat(40) + "\\n" : "5e5610944698e18230c8e67378dda35d8eb311f8\\n") : (args.includes("status") && process.argv[5] === "dirty" ? " M package.json\\n" : "") });
      try { await assertSource(process.argv[3], git, async () => events.push("exec")); await writeFile(process.argv[4], JSON.stringify({ ok: true, events })); }
      catch (error) { await writeFile(process.argv[4], JSON.stringify({ ok: false, message: error.message, events })); }
    `);
    await execFile("/Users/taejunoh/.nvm/versions/node/v22.22.2/bin/node", [harness, runnerUrl, source, output, kind]);
    return JSON.parse(await (await import("node:fs/promises")).readFile(output, "utf8"));
  });
}

describe("isolated DB rehearsal", () => {
  it.each([databaseUrl, databaseUrl.replace("/neondb?", ":5432/neondb?")])("accepts exact Neon URL with effective port 5432", async (url) => {
    const result = await probe({ validateOnly: true, databaseUrl: url, manifest, deny });
    expect(result).toMatchObject({ ok: true, result: { port: 5432 } });
  });

  it.each([
    databaseUrl.replace(host, "prod.neon.tech"), databaseUrl.replace("neondb_owner", "other"),
    databaseUrl.replace("/neondb?", ":6543/neondb?"), databaseUrl.replace("/neondb?", "/other?"),
    databaseUrl.replace("sslmode=require", "sslmode=disable"), databaseUrl.replace("channel_binding=require", "channel_binding=prefer"),
    `${databaseUrl}&options=-c%20search_path%3Dpublic`,
  ])("refuses unsafe URL before source checks or a DB connection", async (url) => {
    const result = await probe({ databaseUrl: url, manifest, deny });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Isolated DB rehearsal refused");
    expect(result.events).toEqual([]);
  });

  it("refuses a row that appears after migration but before fixture insertion", async () => {
    const result = await probe({ databaseUrl, manifest, deny, applicationCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.events.some((event: string) => event.includes('INSERT INTO "Application"') || event.startsWith("DELETE"))).toBe(false);
    expect(result.events).toContain("end");
  });

  it.each([
    ["a fixed target mismatch", { ...manifest, database: { ...manifest.database, endpointId: "other" } }, deny],
    ["a production deny overlap", manifest, { ...deny, neonProjectIds: [...deny.neonProjectIds, manifest.database.projectId] }],
  ])("refuses %s before source checks or a DB connection", async (_, candidate, candidateDeny) => {
    const result = await probe({ databaseUrl, manifest: candidate, deny: candidateDeny });
    expect(result).toMatchObject({ ok: false, message: "Isolated DB rehearsal refused", events: [] });
  });

  it.each([
    { ...manifest, sourceSha: "f".repeat(40) }, { ...manifest, vercelProjectId: "other" }, { ...manifest, neonOrganizationId: "other" },
    { ...manifest, database: { ...manifest.database, projectId: "other" } }, { ...manifest, database: { ...manifest.database, branchId: "other" } },
    { ...manifest, database: { ...manifest.database, endpointId: "other" } }, { ...manifest, database: { ...manifest.database, host: "other.neon.tech" } },
    { ...manifest, database: { ...manifest.database, port: 6543 } }, { ...manifest, database: { ...manifest.database, database: "other" } },
  ])("refuses every independently fixed target field before source checks", async (candidate) => {
    const result = await probe({ databaseUrl, manifest: candidate, deny });
    expect(result).toMatchObject({ ok: false, message: "Isolated DB rehearsal refused", events: [] });
  });

  it.each([
    { ...deny, vercelProjectIds: [...deny.vercelProjectIds, manifest.vercelProjectId] },
    { ...deny, neonOrganizationIds: [...deny.neonOrganizationIds, manifest.neonOrganizationId] },
    { ...deny, neonProjectIds: [...deny.neonProjectIds, manifest.database.projectId] },
    { ...deny, databaseHosts: [...deny.databaseHosts, manifest.database.host] },
  ])("refuses each production deny-list category before source checks", async (candidateDeny) => {
    const result = await probe({ databaseUrl, manifest, deny: candidateDeny });
    expect(result).toMatchObject({ ok: false, message: "Isolated DB rehearsal refused", events: [] });
  });

  it.each([
    ["a pre-existing migration table", { database: "neondb", port: 5432, schema: "public", migrationTable: "_prisma_migrations", marker: null, publicRelations: [] }],
    ["a pre-existing marker", { database: "neondb", port: 5432, schema: "public", migrationTable: null, marker: "environment_marker", publicRelations: [] }],
    ["a pre-existing public relation", { database: "neondb", port: 5432, schema: "public", migrationTable: null, marker: null, publicRelations: ["Application"] }],
  ])("refuses %s before marker, child, fixture, or delete mutation", async (_, identity) => {
    const result = await probe({ databaseUrl, manifest, deny, identity });
    expect(result.ok).toBe(false);
    expect(result.events.some((event: string) => event.includes("CREATE ") || event.includes("INSERT ") || event.startsWith("exec:") || event.startsWith("DELETE"))).toBe(false);
  });

  it("casts pg_class name[] output to text[] before the strict fresh-array check", async () => {
    const result = await probe({ databaseUrl, manifest, deny, pgNameArray: true });
    expect(result.ok).toBe(true);
    expect(result.events).toContain("summary:complete");
  });

  it.each([
    ["a dirty or wrong source", { sourceFailure: true }],
    ["an unavailable lock", { lock: false }],
  ])("makes no marker, child, fixture, or delete mutation after %s", async (_, options) => {
    const result = await probe({ databaseUrl, manifest, deny, ...options });
    expect(result.ok).toBe(false);
    expect(result.events.some((event: string) => event.includes("CREATE ") || event.includes("INSERT ") || event.startsWith("exec:") || event.startsWith("DELETE"))).toBe(false);
    if (!(options as { sourceFailure?: boolean }).sourceFailure) expect(result.events).toContain("end");
  });

  it.each(["migrate deploy", "migrate status", "backfill-application-identities.mjs --report"])("rolls back only active work and cleans durable fixtures after failed %s", async (failure) => {
    const result = await probe({ databaseUrl, manifest, deny, failExec: failure });
    expect(result.ok).toBe(false);
    expect(result.events).toContain("end");
    if (failure.includes("backfill")) expect(result.events.some((event: string) => event.startsWith("DELETE"))).toBe(true);
    else expect(result.events.some((event: string) => event.startsWith("DELETE"))).toBe(false);
  });

  it("refuses unknown cleanup rows without deletion and still unlocks, ends, and reports pending cleanup", async () => {
    const result = await probe({ databaseUrl, manifest, deny, cleanupRows: ["unknown"] });
    expect(result.ok).toBe(false);
    expect(result.events.some((event: string) => event.startsWith("DELETE"))).toBe(false);
    expect(result.events).toContain("end");
    expect(result.events).toContain("summary:pending");
    expect(result.events.some((event: string) => event.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("records pending cleanup and still unlocks, ends, and reports when a delete itself fails", async () => {
    const result = await probe({ databaseUrl, manifest, deny, failQuery: 'DELETE FROM "Application"' });
    expect(result.ok).toBe(false);
    expect(result.events).toContain("end");
    expect(result.events).toContain("summary:pending");
    expect(result.events.some((event: string) => event.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("refuses a marker with a different manifest digest before migration, fixtures, or child processes", async () => {
    const result = await probe({ databaseUrl, manifest, deny, markerDigest: "0".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.events.some((event: string) => event.startsWith("exec:") || event.includes('INSERT INTO "Application"') || event.startsWith("DELETE"))).toBe(false);
    expect(result.events).toContain("end");
  });

  it("refuses a missing durable marker before migration, fixtures, or child processes", async () => {
    const result = await probe({ databaseUrl, manifest, deny, markerRows: "unknown" });
    expect(result.ok).toBe(false);
    expect(result.events.some((event: string) => event.startsWith("exec:") || event.includes('INSERT INTO "Application"') || event.startsWith("DELETE"))).toBe(false);
    expect(result.events).toContain("end");
  });

  it("stops after an incorrect identity result and only performs owned cleanup", async () => {
    const applicationRows = [{ id: "isr-0001-canonical", identityKey: null, canonicalUrl: null, duplicateOfId: null, identityState: "legacy_unresolved" }];
    const result = await probe({ databaseUrl, manifest, deny, applicationRows });
    expect(result.ok).toBe(false);
    expect(result.events.filter((event: string) => event.startsWith("exec:")).length).toBe(4);
    expect(result.events.filter((event: string) => event.startsWith("DELETE"))).toHaveLength(3);
  });

  it("stops after malformed backfill evidence and only performs owned cleanup", async () => {
    const result = await probe({ databaseUrl, manifest, deny, badReport: true });
    expect(result.ok).toBe(false);
    expect(result.events.filter((event: string) => event.startsWith("exec:")).length).toBe(6);
    expect(result.events.filter((event: string) => event.startsWith("DELETE"))).toHaveLength(3);
  });

  it("checks identity results, report equality, post-cleanup state, and completes the owned fixture lifecycle", async () => {
    const result = await probe({ databaseUrl, manifest, deny });
    expect(result.ok).toBe(true);
    expect(result.events.filter((event: string) => event.startsWith("DELETE"))).toHaveLength(3);
    expect(result.events).toContain("summary:complete");
    expect(result.events).toContain("end");
  });

  it.each(["manifest", "deny"])("uses the existing private-input parser and rejects non-0600 %s material before connecting", async (kind) => {
    await temporary(async (directory) => {
      const manifestPath = join(directory, "manifest.json");
      const denyPath = join(directory, "deny.json");
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: kind === "manifest" ? 0o644 : 0o600 });
      await writeFile(denyPath, JSON.stringify(deny), { mode: kind === "deny" ? 0o644 : 0o600 });
      await chmod(kind === "manifest" ? manifestPath : denyPath, 0o644);
      const result = await probe({ databaseUrl, manifestPath, denyPath, manifest: undefined, deny: undefined });
      expect(result).toMatchObject({ ok: false, events: [] });
    });
  });

  it.each(["missing", "symlink", "env", "wrong-sha", "dirty"] as const)("refuses a %s source path before dependency installation", async (kind) => {
    const result = await sourceProbe(kind);
    expect(result).toMatchObject({ ok: false, message: "Isolated DB rehearsal refused", events: [] });
  });

  it("permits only the approved tracked dotenv example before dependency installation", async () => {
    const result = await sourceProbe("example");
    expect(result).toMatchObject({ ok: true, events: ["exec", "exec", "exec"] });
  });
});
