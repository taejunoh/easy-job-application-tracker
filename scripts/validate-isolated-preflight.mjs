// @ts-check
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const CANONICAL_REPOSITORY_ROOT = realpathSync(REPOSITORY_ROOT);

export const REVIEWED_PATHS = Object.freeze([
  "prisma/schema.prisma", "prisma/migrations", "prisma.config.ts",
  "src/lib/applications/backfill.ts", "src/lib/applications/identity.ts",
]);
const SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const ID = /^[A-Za-z0-9_-]+$/u;
const MANIFEST_KEYS = ["schemaVersion", "kind", "environmentId", "sourceSha", "vercelProjectId", "neonOrganizationId", "database"];
const DATABASE_KEYS = ["projectId", "branchId", "endpointId", "host", "port", "database"];
const DENY_KEYS = ["schemaVersion", "kind", "vercelProjectIds", "neonOrganizationIds", "neonProjectIds", "databaseHosts"];

function refused() {
  return new Error("Isolated validation preflight refused");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function string(value, pattern = undefined) {
  return typeof value === "string" && value.length > 0 && (pattern === undefined || pattern.test(value));
}

function list(value, pattern) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => string(entry, pattern)) && new Set(value).size === value.length;
}

function outsideRepository(path) {
  const value = relative(CANONICAL_REPOSITORY_ROOT, path);
  return value === ".." || value.startsWith(`..${sep}`);
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    const parent = await realpath(dirname(path)).catch(() => { throw refused(); });
    return resolve(parent, path.slice(dirname(path).length + 1));
  }
}

async function assertOutsideRepository(path) {
  if (!isAbsolute(path)) throw refused();
  const canonical = await canonicalPath(path);
  if (!outsideRepository(canonical)) throw refused();
  return canonical;
}

export async function readPrivateJson(path, expectedKind) {
  await assertOutsideRepository(path);
  const info = await lstat(path).catch(() => { throw refused(); });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 || (info.mode & 0o077) !== 0) throw refused();
  const bytes = await readFile(path, "utf8").catch(() => { throw refused(); });
  let value;
  try { value = JSON.parse(bytes); } catch { throw refused(); }
  if (!object(value) || value.kind !== expectedKind) throw refused();
  return { value, bytes };
}

export function parseManifest(value) {
  if (!exactKeys(value, MANIFEST_KEYS) || value.schemaVersion !== 1 || value.kind !== "jobtracker-isolated-validation-manifest" || !string(value.environmentId, UUID) || !string(value.sourceSha, SHA) || !string(value.vercelProjectId, ID) || !string(value.neonOrganizationId, ID) || !exactKeys(value.database, DATABASE_KEYS)) throw refused();
  const database = value.database;
  if (!string(database.projectId, ID) || !string(database.branchId, ID) || !string(database.endpointId, ID) || !string(database.host, HOST) || !Number.isInteger(database.port) || database.port < 1 || database.port > 65535 || !string(database.database, ID)) throw refused();
  return value;
}

export function parseDenyList(value) {
  if (!exactKeys(value, DENY_KEYS) || value.schemaVersion !== 1 || value.kind !== "jobtracker-production-deny-list" || !list(value.vercelProjectIds, ID) || !list(value.neonOrganizationIds, ID) || !list(value.neonProjectIds, ID) || !list(value.databaseHosts, HOST)) throw refused();
  return value;
}

function assertTarget(manifest, denyList, sourceSha) {
  if (!string(sourceSha, SHA) || manifest.sourceSha !== sourceSha || denyList.vercelProjectIds.includes(manifest.vercelProjectId) || denyList.neonOrganizationIds.includes(manifest.neonOrganizationId) || denyList.neonProjectIds.includes(manifest.database.projectId) || denyList.databaseHosts.includes(manifest.database.host)) throw refused();
}

export async function realGit(args) {
  try {
    const result = await execFile("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { code: error?.code ?? 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
  }
}

async function assertReviewedPaths(sourceSha, git) {
  for (const path of REVIEWED_PATHS) {
    const tree = await git(["cat-file", "-e", `${sourceSha}:${path}`]);
    if (tree.code !== 0) throw refused();
    const checkoutPath = join(REPOSITORY_ROOT, path);
    const info = await lstat(checkoutPath).catch(() => { throw refused(); });
    const expectedDirectory = path === "prisma/migrations";
    if (info.isSymbolicLink() || (expectedDirectory ? !info.isDirectory() : !info.isFile())) throw refused();
    const canonical = await canonicalPath(checkoutPath);
    if (outsideRepository(canonical)) throw refused();
  }
}

export async function preflight({ manifestPath, denyListPath, reportPath, sourceSha, git = realGit }) {
  const workingDirectory = await realpath(process.cwd()).catch(() => { throw refused(); });
  if (workingDirectory !== CANONICAL_REPOSITORY_ROOT) throw refused();
  await assertOutsideRepository(reportPath);
  const [manifestInput, denyListInput] = await Promise.all([
    readPrivateJson(manifestPath, "jobtracker-isolated-validation-manifest"),
    readPrivateJson(denyListPath, "jobtracker-production-deny-list"),
  ]);
  const manifest = parseManifest(manifestInput.value);
  const denyList = parseDenyList(denyListInput.value);
  assertTarget(manifest, denyList, sourceSha);
  if ((await git(["cat-file", "-e", `${sourceSha}^{commit}`])).code !== 0) throw refused();
  await assertReviewedPaths(sourceSha, git);
  if ((await git(["diff", "--quiet", sourceSha, "--", ...REVIEWED_PATHS])).code !== 0) throw refused();
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...REVIEWED_PATHS]);
  if (status.code !== 0 || status.stdout !== "") throw refused();
  const report = { schemaVersion: 1, kind: "jobtracker-isolated-validation-preflight-report", sourceSha, manifestDigest: createHash("sha256").update(manifestInput.bytes).digest("hex"), checkedPaths: REVIEWED_PATHS };
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(() => { throw refused(); });
  return report;
}

function parseArgs(args) {
  if (args.length !== 8) throw refused();
  const values = {};
  const flags = new Set(["--manifest", "--deny-list", "--report", "--source-sha"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flags.has(flag) || Object.hasOwn(values, flag) || !value || value.startsWith("--")) throw refused();
    values[flag] = value;
  }
  return { manifestPath: values["--manifest"], denyListPath: values["--deny-list"], reportPath: values["--report"], sourceSha: values["--source-sha"] };
}

function invokedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH); } catch { return false; }
}

if (invokedDirectly()) {
  Promise.resolve()
    .then(() => preflight(parseArgs(process.argv.slice(2))))
    .then(() => process.stdout.write("Isolated validation preflight passed.\n"))
    .catch(() => { process.stderr.write("Isolated validation preflight refused.\n"); process.exitCode = 1; });
}
