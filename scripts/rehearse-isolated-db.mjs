import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { parseDenyList, parseManifest, readPrivateJson } from "./validate-isolated-preflight.mjs";

const execFile = promisify(execFileCallback);
const NODE_BIN = "/Users/taejunoh/.nvm/versions/node/v22.22.2/bin";
const APPROVED_SHA = "5e5610944698e18230c8e67378dda35d8eb311f8";
const FIXED_TARGET = Object.freeze({
  vercelProjectId: "prj_ZVWlit980NwxpRCloaqqG9nchecf",
  neonOrganizationId: "org-dawn-dust-44814444",
  projectId: "raspy-wave-56679088",
  branchId: "br-ancient-brook-ausbwkau",
  endpointId: "ep-bitter-moon-aux0rv8i",
  host: "ep-bitter-moon-aux0rv8i.c-10.us-east-1.aws.neon.tech",
  database: "neondb",
  port: 5432,
  user: "neondb_owner",
});
const FIXTURES = Object.freeze([
  ["isr-0001-canonical", "https://jobs.validation.example/roles/alpha"],
  ["isr-0002-duplicate", "https://jobs.validation.example/roles/alpha?utm_source=rehearsal"],
  ["isr-0003-unresolved", "not a URL"],
]);
const FIXTURE_IDS = Object.freeze(FIXTURES.map(([id]) => id));
const REQUIRED_PATHS = Object.freeze([
  ["package.json", "file"], ["package-lock.json", "file"], ["prisma.config.ts", "file"],
  ["prisma/schema.prisma", "file"], ["prisma/migrations", "directory"],
  ["prisma/migrations/migration_lock.toml", "file"],
  ["scripts/backfill-application-identities.mjs", "file"],
  ["src/lib/applications/backfill.ts", "file"], ["src/lib/applications/identity.ts", "file"],
]);
const EXPECTED_MIGRATIONS = Object.freeze([
  "20260713000000_init", "20260813010000_application_identity", "20260813020000_extension_installations",
]);
const EXPECTED_IDENTITY_ROWS = Object.freeze([
  { id: "isr-0001-canonical", identityKey: "url-v1:1541d4212c992b23bd3f8169c924f603700a2859b187e6771b999021bff87aeb", canonicalUrl: "https://jobs.validation.example/roles/alpha", duplicateOfId: null, identityState: "canonical" },
  { id: "isr-0002-duplicate", identityKey: null, canonicalUrl: "https://jobs.validation.example/roles/alpha", duplicateOfId: "isr-0001-canonical", identityState: "legacy_duplicate" },
  { id: "isr-0003-unresolved", identityKey: null, canonicalUrl: null, duplicateOfId: null, identityState: "legacy_unresolved" },
]);

function refuse() {
  throw new Error("Isolated DB rehearsal refused");
}

function same(values, expected) {
  return Array.isArray(values) && values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeEnv(databaseUrl = undefined) {
  return {
    PATH: `${NODE_BIN}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  };
}

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  refuse();
}

function assertTarget(manifest, deny) {
  const database = manifest?.database;
  if (!database || manifest.sourceSha !== APPROVED_SHA || manifest.vercelProjectId !== FIXED_TARGET.vercelProjectId ||
    manifest.neonOrganizationId !== FIXED_TARGET.neonOrganizationId || database.projectId !== FIXED_TARGET.projectId ||
    database.branchId !== FIXED_TARGET.branchId || database.endpointId !== FIXED_TARGET.endpointId ||
    database.host !== FIXED_TARGET.host || database.port !== FIXED_TARGET.port || database.database !== FIXED_TARGET.database ||
    deny?.vercelProjectIds?.includes(manifest.vercelProjectId) || deny?.neonOrganizationIds?.includes(manifest.neonOrganizationId) ||
    deny?.neonProjectIds?.includes(database.projectId) || deny?.databaseHosts?.includes(database.host)) refuse();
}

export function validateUrl(databaseUrl, manifest, deny) {
  let url;
  try { url = new URL(databaseUrl); } catch { refuse(); }
  const port = url.port === "" ? 5432 : Number(url.port);
  const entries = [...url.searchParams.entries()];
  const required = new Map([["sslmode", "require"], ["channel_binding", "require"]]);
  if (!databaseUrl || !["postgres:", "postgresql:"].includes(url.protocol) || url.username !== FIXED_TARGET.user || !url.password ||
    url.hostname !== FIXED_TARGET.host || !Number.isInteger(port) || port !== 5432 || url.pathname !== "/neondb" ||
    url.hash || entries.length !== required.size || new Set(entries.map(([key]) => key)).size !== required.size ||
    entries.some(([key, value]) => required.get(key) !== value) || manifest?.database?.host !== url.hostname ||
    manifest.database.port !== port || manifest.database.database !== "neondb" || deny?.databaseHosts?.includes(url.hostname)) refuse();
  return Object.freeze({ port });
}

export async function assertSource(sourceRoot, git = execFile, exec = execFile) {
  if (!isAbsolute(sourceRoot)) refuse();
  const sourceInfo = await lstat(sourceRoot).catch(() => refuse());
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) refuse();
  const canonicalRoot = await realpath(sourceRoot).catch(() => refuse());
  if ((await git("git", ["-C", canonicalRoot, "rev-parse", "HEAD"])).stdout.trim() !== APPROVED_SHA ||
    (await git("git", ["-C", canonicalRoot, "status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") refuse();
  await git("git", ["-C", canonicalRoot, "diff", "--quiet", APPROVED_SHA, "--"]);
  for (const [path, kind] of REQUIRED_PATHS) {
    await git("git", ["-C", canonicalRoot, "cat-file", "-e", `${APPROVED_SHA}:${path}`]);
    const actual = join(canonicalRoot, path);
    const info = await lstat(actual).catch(() => refuse());
    const canonical = await realpath(actual).catch(() => refuse());
    if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory()) || !contained(canonicalRoot, canonical)) refuse();
  }
  const names = await readdir(canonicalRoot).catch(() => refuse());
  if (names.some((name) => name.startsWith(".env"))) refuse();
  await exec(join(NODE_BIN, "npm"), ["ci", "--ignore-scripts"], { cwd: canonicalRoot, env: safeEnv(), stdio: "pipe" });
  await exec(join(NODE_BIN, "npm"), ["rebuild", "@prisma/engines", "--ignore-scripts=false"], { cwd: canonicalRoot, env: safeEnv(), stdio: "pipe" });
  await exec(join(NODE_BIN, "node"), [join(canonicalRoot, "node_modules/prisma/build/index.js"), "--version"], { cwd: canonicalRoot, env: safeEnv(), stdio: "pipe" });
}

async function reserveReports(artifacts) {
  if (!isAbsolute(artifacts)) refuse();
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  for (const name of ["summary.json", "01-dry.json", "02-apply.json", "03-dry.json", "04-apply.json"]) await absent(join(artifacts, name));
}

async function queryOne(client, sql, values = []) {
  const result = await client.query(sql, values);
  if (!Array.isArray(result?.rows) || result.rows.length !== 1) refuse();
  return result.rows[0];
}

function isFresh(row, manifest) {
  return row.database === manifest.database.database && row.port === manifest.database.port && row.schema === "public" &&
    row.migrationTable === null && row.marker === null && same(row.publicRelations, []);
}

async function assertMarker(client, manifest, runnerSha, fixtureIds) {
  const row = await queryOne(client,
    'SELECT "environmentId", "appSourceSha", "runnerSha", "fixtureIds" FROM "validation_control"."environment_marker" WHERE "environmentId"=$1',
    [manifest.environmentId]);
  if (row.environmentId !== manifest.environmentId || row.appSourceSha !== APPROVED_SHA || row.runnerSha !== runnerSha || !same(row.fixtureIds, fixtureIds)) refuse();
}

async function runBackfill(exec, sourceRoot, databaseUrl, args) {
  await exec(join(NODE_BIN, "node"), ["scripts/backfill-application-identities.mjs", ...args], {
    cwd: sourceRoot, env: safeEnv(databaseUrl), stdio: "pipe",
  });
}

async function verifyReports(readReport, artifacts) {
  const reports = await Promise.all(["01-dry.json", "02-apply.json", "03-dry.json", "04-apply.json"].map((name) => readReport(join(artifacts, name))));
  const expectedTotals = { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 };
  for (const [index, report] of reports.entries()) {
    if (!report || report.schemaVersion !== 1 || report.mode !== (index % 2 === 0 ? "dry-run" : "apply") ||
      report.rowCountBefore !== 3 || report.rowCountAfter !== 3 || report.uniqueIndexVerified !== true || !sameJson(report.stateTotals, expectedTotals)) refuse();
  }
  if (!sameJson(reports[0], reports[2]) || !sameJson(reports[1], reports[3])) refuse();
}

async function verifyIdentityRows(client) {
  const result = await client.query(
    'SELECT "id","identityKey","canonicalUrl","duplicateOfId","identityState" FROM "Application" WHERE "id" = ANY($1::text[]) ORDER BY "id"',
    [FIXTURE_IDS],
  );
  if (!sameJson(result?.rows, EXPECTED_IDENTITY_ROWS)) refuse();
}

async function assertCleanupScope(client, manifest, runnerSha, expectedIds) {
  await assertMarker(client, manifest, runnerSha, FIXTURE_IDS);
  const applications = await client.query('SELECT "id" FROM "Application" ORDER BY "id"');
  if (!same(applications?.rows?.map((row) => row.id), expectedIds)) refuse();
  const row = await queryOne(client,
    'SELECT (SELECT count(*)::int FROM "Settings") AS settings, (SELECT count(*)::int FROM "ExtensionInstallation") AS installations, (SELECT count(*)::int FROM "ExtensionPairingGrant") AS grants');
  if (row.settings !== 0 || row.installations !== 0 || row.grants !== 0) refuse();
}

async function cleanupOwnedFixtures(client, manifest, runnerSha) {
  await assertCleanupScope(client, manifest, runnerSha, FIXTURE_IDS);
  const remaining = [...FIXTURE_IDS];
  for (const id of [...FIXTURE_IDS].reverse()) {
    const result = await client.query('DELETE FROM "Application" WHERE "id"=$1::text', [id]);
    if (result?.rowCount !== 1) refuse();
    remaining.splice(remaining.indexOf(id), 1);
    await assertCleanupScope(client, manifest, runnerSha, remaining);
  }
  const applicationCount = await queryOne(client, 'SELECT count(*)::int AS count FROM "Application"');
  if (applicationCount.count !== 0) refuse();
  const migrations = await client.query('SELECT migration_name AS name FROM "_prisma_migrations" ORDER BY migration_name');
  if (!same(migrations?.rows?.map((row) => row.name), EXPECTED_MIGRATIONS)) refuse();
  await assertMarker(client, manifest, runnerSha, FIXTURE_IDS);
}

function manifestDigest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export async function run(input) {
  const manifest = input.manifest ?? parseManifest((await readPrivateJson(input.manifestPath, "jobtracker-isolated-validation-manifest")).value);
  const deny = input.deny ?? parseDenyList((await readPrivateJson(input.denyPath, "jobtracker-production-deny-list")).value);
  const { sourceRoot, artifacts, runnerSha, databaseUrl, exec = execFile, git = execFile } = input;
  assertTarget(manifest, deny);
  validateUrl(databaseUrl, manifest, deny);
  await (input.assertSource ?? assertSource)(sourceRoot, git, exec);
  await (input.reserveReports ?? reserveReports)(artifacts);

  const client = input.client ?? new pg.Client({ connectionString: databaseUrl });
  const readReport = input.readReport ?? (async (path) => JSON.parse(await readFile(path, "utf8")));
  const writeSummary = input.writeSummary ?? (async (value) => writeFile(join(artifacts, "summary.json"), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" }));
  let connected = false;
  let locked = false;
  let inTransaction = false;
  let owned = false;
  let cleanup = "not_started";
  let failure;

  try {
    await client.connect();
    connected = true;
    const identity = await queryOne(client,
      "SELECT current_database() AS database, inet_server_port() AS port, current_schema() AS schema, to_regclass('public._prisma_migrations') AS \"migrationTable\", to_regclass('validation_control.environment_marker') AS marker, COALESCE(array_agg(c.relname ORDER BY c.relname) FILTER (WHERE c.oid IS NOT NULL), ARRAY[]::text[]) AS \"publicRelations\" FROM pg_class c LEFT JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public' WHERE c.oid IS NULL OR n.oid IS NOT NULL");
    if (!isFresh(identity, manifest)) refuse();
    if (!(await queryOne(client, "SELECT pg_try_advisory_lock(hashtextextended('jobtracker-isolated-db-rehearsal-v1:' || $1, 0)) AS acquired", [manifest.environmentId])).acquired) refuse();
    locked = true;

    await client.query("BEGIN"); inTransaction = true;
    await client.query('CREATE SCHEMA "validation_control"');
    await client.query('CREATE TABLE "validation_control"."environment_marker" ("environmentId" TEXT PRIMARY KEY, "appSourceSha" TEXT NOT NULL, "runnerSha" TEXT NOT NULL, "manifestDigest" TEXT NOT NULL, "fixtureIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await client.query('INSERT INTO "validation_control"."environment_marker" ("environmentId","appSourceSha","runnerSha","manifestDigest") VALUES ($1,$2,$3,$4)', [manifest.environmentId, APPROVED_SHA, runnerSha, manifestDigest(manifest)]);
    await client.query("COMMIT"); inTransaction = false;

    await assertMarker(client, manifest, runnerSha, []);
    await exec(join(NODE_BIN, "node"), [join(sourceRoot, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: sourceRoot, env: safeEnv(databaseUrl), stdio: "pipe" });
    await assertMarker(client, manifest, runnerSha, []);
    await exec(join(NODE_BIN, "node"), [join(sourceRoot, "node_modules/prisma/build/index.js"), "migrate", "status"], { cwd: sourceRoot, env: safeEnv(databaseUrl), stdio: "pipe" });
    if ((await queryOne(client, 'SELECT count(*)::int AS count FROM "Application"')).count !== 0) refuse();

    await assertMarker(client, manifest, runnerSha, []);
    await client.query("BEGIN"); inTransaction = true;
    await client.query('UPDATE "validation_control"."environment_marker" SET "fixtureIds"=$1 WHERE "environmentId"=$2', [FIXTURE_IDS, manifest.environmentId]);
    for (const [id, url] of FIXTURES) await client.query('INSERT INTO "Application" ("id","url","jobTitle","company","status","appliedDate","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$6,$6)', [id, url, `Synthetic ${id}`, "Validation", "Applied", new Date("2026-08-01T00:00:00.000Z")]);
    await client.query("COMMIT"); inTransaction = false;
    owned = true;

    const backfills = [["--report", join(artifacts, "01-dry.json")], ["--apply", "--writers-stopped", "--report", join(artifacts, "02-apply.json")], ["--report", join(artifacts, "03-dry.json")], ["--apply", "--writers-stopped", "--report", join(artifacts, "04-apply.json")]];
    for (const args of backfills) {
      await assertMarker(client, manifest, runnerSha, FIXTURE_IDS);
      await runBackfill(exec, sourceRoot, databaseUrl, args);
      if (args.includes("--apply")) await verifyIdentityRows(client);
    }
    await verifyReports(readReport, artifacts);
  } catch (error) {
    failure = error;
    if (connected && inTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
      inTransaction = false;
    }
  } finally {
    if (owned) {
      try {
        await cleanupOwnedFixtures(client, manifest, runnerSha);
        cleanup = "complete";
      } catch {
        cleanup = "pending";
      }
    }
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('jobtracker-isolated-db-rehearsal-v1:' || $1, 0))", [manifest.environmentId]).catch(() => undefined);
    if (connected) await client.end().catch(() => undefined);
    await writeSummary({ appSourceSha: APPROVED_SHA, runnerSha, fixtureIds: owned ? FIXTURE_IDS : [], cleanup }).catch(() => { failure ??= new Error("Isolated DB rehearsal refused"); });
  }
  if (failure || cleanup === "pending") refuse();
}

function parseArgs(args) {
  if (args.length !== 8) refuse();
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!["--source-root", "--manifest", "--deny-list", "--artifacts"].includes(flag) || Object.hasOwn(values, flag) || !isAbsolute(value)) refuse();
    values[flag] = value;
  }
  return values;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const status = await execFile("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout !== "") refuse();
  const runnerSha = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(runnerSha) || !process.env.DATABASE_URL) refuse();
  await run({ sourceRoot: values["--source-root"], manifestPath: values["--manifest"], denyPath: values["--deny-list"], artifacts: values["--artifacts"], runnerSha, databaseUrl: process.env.DATABASE_URL });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Isolated DB rehearsal refused\n"); process.exitCode = 1; });
}
