// @ts-check
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const REQUIRED_NODE = "/Users/taejunoh/.nvm/versions/node/v22.22.2/bin/node";
const REQUIRED_VERCEL_VERSION = "50.40.0";
const SHA = /^[0-9a-f]{40}$/u;
const POSIX_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9!#$%&'()+,\-.=@\[\]^_{}~\/]+$/u;

function refused() { return new Error("Vercel upload manifest capture refused"); }

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

async function privateDirectory(path) {
  if (!isAbsolute(path)) throw refused();
  const info = await lstat(path).catch(() => { throw refused(); });
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw refused();
  return realpath(path).catch(() => { throw refused(); });
}

async function privateFile(path, directory, { exists }) {
  if (!isAbsolute(path) || basename(path) !== path.slice(dirname(path).length + 1)) throw refused();
  const parent = await realpath(dirname(path)).catch(() => { throw refused(); });
  if (parent !== directory) throw refused();
  const candidate = join(parent, basename(path));
  const info = await lstat(candidate).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!exists) {
    if (info !== undefined) throw refused();
    return candidate;
  }
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024 * 1024) throw refused();
  const canonical = await realpath(candidate).catch(() => { throw refused(); });
  if (dirname(canonical) !== directory) throw refused();
  return canonical;
}

async function sourceRoot(path, expectedSha) {
  if (!isAbsolute(path) || !SHA.test(expectedSha)) throw refused();
  const info = await lstat(path).catch(() => { throw refused(); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
  const canonical = await realpath(path).catch(() => { throw refused(); });
  const head = await git(canonical, ["rev-parse", "HEAD"]);
  const status = await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (head !== expectedSha || status !== "") throw refused();
  return canonical;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
    return stdout.trimEnd();
  } catch { throw refused(); }
}

function loopbackApi(value) {
  let url;
  try { url = new URL(value); } catch { throw refused(); }
  if (url.protocol !== "https:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw refused();
  return url.toString().replace(/\/$/u, "");
}

async function requiredRuntime() {
  if (process.execPath !== REQUIRED_NODE) throw refused();
  let stdout;
  try { ({ stdout } = await execFile("vercel", ["--version"], { encoding: "utf8" })); } catch { throw refused(); }
  if (stdout.trim() !== REQUIRED_VERCEL_VERSION) throw refused();
}

function normalizePath(value) {
  if (typeof value !== "string" || !POSIX_PATH.test(value) || value.includes("\\")) throw refused();
  return value;
}

async function localFile(root, path) {
  const candidate = resolve(root, path);
  const contained = relative(root, candidate);
  if (contained === "" || contained === ".." || contained.startsWith(`..${sep}`)) throw refused();
  const info = await lstat(candidate).catch(() => { throw refused(); });
  if (!info.isFile() || info.isSymbolicLink()) throw refused();
  const canonical = await realpath(candidate).catch(() => { throw refused(); });
  if (relative(root, canonical).startsWith(`..${sep}`) || relative(root, canonical) === "..") throw refused();
  return { bytes: await readFile(canonical), size: info.size };
}

function digest(bytes, algorithm) { return createHash(algorithm).update(bytes).digest("hex"); }

async function manifestFromCapture({ capturePath, root, expectedSha }) {
  let payload;
  try { payload = JSON.parse(await readFile(capturePath, "utf8")); } catch { throw refused(); }
  if (!isObject(payload) || !Array.isArray(payload.files) || payload.files.length === 0) throw refused();
  const paths = new Set();
  const files = [];
  for (const item of payload.files) {
    if (!isObject(item) || Object.keys(item).some((key) => !["file", "sha", "size", "mode"].includes(key)) || typeof item.file !== "string" || typeof item.sha !== "string" || item.sha.length === 0 || !Number.isFinite(item.size) || item.size < 0 || !Number.isInteger(item.size) || !Number.isFinite(item.mode) || !Number.isInteger(item.mode)) throw refused();
    const path = normalizePath(item.file);
    if (paths.has(path)) throw refused();
    paths.add(path);
    const local = await localFile(root, path);
    if (local.size !== item.size) throw refused();
    const sha256 = digest(local.bytes, "sha256");
    if ((/^[0-9a-f]{64}$/u.test(item.sha) && item.sha !== sha256) || (/^[0-9a-f]{40}$/u.test(item.sha) && item.sha !== digest(local.bytes, "sha1"))) throw refused();
    files.push({ path, type: "file", sha256, size: local.size, cliSha: item.sha, cliMode: item.mode });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 1, kind: "jobtracker-vercel-upload-manifest", sourceSha: expectedSha, files };
}

async function deployToFakeApi({ root, fakeApi }) {
  try {
    await execFile("vercel", ["--api", fakeApi, "deploy", "--token", "fake", "--target", "preview", "--format", "json", "--yes", "--no-color"], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CI: "1",
        DO_NOT_TRACK: "1",
        VERCEL_TELEMETRY_DISABLED: "1",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    });
    throw refused();
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (!/capture sentinel/u.test(stderr)) throw refused();
  }
}

export async function captureUploadManifest({ sourceRoot: rootPath, expectedSha, privateDir, reportPath, capturePath, fakeApi }) {
  await requiredRuntime();
  const privateRoot = await privateDirectory(privateDir);
  const report = await privateFile(reportPath, privateRoot, { exists: false });
  const capture = await privateFile(capturePath, privateRoot, { exists: false });
  const root = await sourceRoot(rootPath, expectedSha);
  const api = loopbackApi(fakeApi);
  await deployToFakeApi({ root, fakeApi: api });
  const received = await privateFile(capture, privateRoot, { exists: true });
  const manifest = await manifestFromCapture({ capturePath: received, root, expectedSha });
  await writeFile(report, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(() => { throw refused(); });
  return manifest;
}

function parseArgs(args) {
  if (args.length !== 12) throw refused();
  const flags = new Set(["--source-root", "--expected-sha", "--private-dir", "--report", "--capture-file", "--fake-api"]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flags.has(flag) || Object.hasOwn(values, flag) || typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw refused();
    values[flag] = value;
  }
  return { sourceRoot: values["--source-root"], expectedSha: values["--expected-sha"], privateDir: values["--private-dir"], reportPath: values["--report"], capturePath: values["--capture-file"], fakeApi: values["--fake-api"] };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  captureUploadManifest(parseArgs(process.argv.slice(2)))
    .then(() => process.stdout.write("Vercel upload manifest captured.\n"))
    .catch(() => { process.stderr.write("Vercel upload manifest capture refused.\n"); process.exitCode = 1; });
}
