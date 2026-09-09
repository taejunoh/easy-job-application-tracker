// @ts-check
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const REQUIRED_NODE = "/Users/taejunoh/.nvm/versions/node/v22.22.2/bin/node";
const SHA = /^[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9_-]+$/u;
function refused() { return new Error("Preview deployment byte verifier refused"); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

async function privateDir(path) {
  if (!isAbsolute(path)) throw refused(); const info = await lstat(path).catch(() => { throw refused(); });
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw refused();
  return realpath(path).catch(() => { throw refused(); });
}
async function privateFile(path, directory, exists) {
  if (!isAbsolute(path)) throw refused(); const parent = await realpath(dirname(path)).catch(() => { throw refused(); });
  if (parent !== directory) throw refused(); const candidate = join(parent, basename(path));
  const info = await lstat(candidate).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!exists) { if (info) throw refused(); return candidate; }
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 2 * 1024 * 1024) throw refused();
  const canonical = await realpath(candidate).catch(() => { throw refused(); }); if (dirname(canonical) !== directory) throw refused(); return canonical;
}
function parseManifest(value, expectedSha) {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== "jobtracker-vercel-upload-manifest" || value.sourceSha !== expectedSha || !Array.isArray(value.files) || value.files.length === 0) throw refused();
  const paths = new Set(); const files = [];
  for (const file of value.files) {
    if (!object(file) || Object.keys(file).length !== 6 || typeof file.path !== "string" || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u.test(file.path) || file.type !== "file" || !/^[0-9a-f]{64}$/u.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0 || typeof file.cliSha !== "string" || !Number.isInteger(file.cliMode) || paths.has(file.path)) throw refused();
    paths.add(file.path); files.push(file);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function pointer(value, configured) {
  if (typeof configured !== "string" || !configured.startsWith("/") || configured.includes("//")) throw refused();
  let current = value;
  for (const token of configured.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!object(current) || !Object.hasOwn(current, key)) throw refused(); current = current[key];
  }
  if (typeof current !== "string" || current.length === 0) throw refused();
  return current;
}
function decoded(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw refused();
  const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) throw refused(); return bytes;
}
function flatten(node, prefix = "", paths = new Set(), uids = new Set()) {
  if (!object(node) || typeof node.type !== "string") throw refused();
  if (node.type === "directory") {
    if (!Array.isArray(node.children)) throw refused(); const files = [];
    for (const child of node.children) {
      if (!object(child) || typeof child.name !== "string" || !/^(?!\.\.?$)(?!.*\/)[^\0]+$/u.test(child.name)) throw refused();
      files.push(...flatten(child, prefix ? `${prefix}/${child.name}` : child.name, paths, uids));
    } return files;
  }
  if (node.type !== "file" || typeof node.uid !== "string" || node.uid.length === 0 || !Number.isInteger(node.mode) || !prefix || paths.has(prefix) || uids.has(node.uid)) throw refused();
  paths.add(prefix); uids.add(node.uid); return [{ path: prefix, uid: node.uid, apiMode: node.mode }];
}
function metadata(deployment, expectedSha, deploymentId, projectId, teamId, deploymentUrl) {
  if (!object(deployment) || deployment.id !== deploymentId || deployment.target !== null || deployment.readyState !== "READY" || typeof deployment.url !== "string" || `https://${deployment.url}` !== deploymentUrl || !object(deployment.project) || deployment.project.id !== projectId || !object(deployment.team) || deployment.team.id !== teamId || (deployment.projectId !== undefined && deployment.projectId !== projectId) || (deployment.ownerId !== undefined && deployment.ownerId !== teamId)) throw refused();
  const candidates = [deployment.meta?.gitCommitSha, deployment.meta?.githubCommitSha, deployment.gitMetadata?.commitSha]; let present = 0;
  for (const value of candidates) { if (value !== undefined && value !== "") { present += 1; if (typeof value !== "string" || !SHA.test(value) || value !== expectedSha) throw refused(); } }
  if (!present) throw refused();
}
async function liveRequest({ endpoint, teamId }) {
  const { stdout } = await execFile("vercel", ["--api", "https://api.vercel.com", "--scope", teamId, "api", endpoint, "--method", "GET", "--raw"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "1", DO_NOT_TRACK: "1", VERCEL_TELEMETRY_DISABLED: "1", NODE_TLS_REJECT_UNAUTHORIZED: "1" } }).catch(() => { throw refused(); });
  try { return JSON.parse(stdout); } catch { throw refused(); }
}
async function liveRuntimeAndSource(sourceRoot, expectedSha) {
  let version;
  try { ({ stdout: version } = await execFile("vercel", ["--version"], { encoding: "utf8" })); } catch { throw refused(); }
  if (version.trim() !== "50.40.0") throw refused();
  let head; let status;
  try {
    ({ stdout: head } = await execFile("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }));
    ({ stdout: status } = await execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot, encoding: "utf8" }));
  } catch { throw refused(); }
  if (head.trim() !== expectedSha || status !== "") throw refused();
}
export async function verifyDeploymentBytes({ sourceRoot, expectedSha, privateDir: privatePath, manifestPath, reportPath, deploymentId, projectId, teamId, deploymentUrl, base64Pointer, request }) {
  if (!isAbsolute(sourceRoot) || !SHA.test(expectedSha) || !ID.test(deploymentId) || !ID.test(projectId) || !ID.test(teamId) || typeof deploymentUrl !== "string" || !/^https:\/\/[a-z0-9-]+\.vercel\.app$/u.test(deploymentUrl) || process.execPath !== REQUIRED_NODE) throw refused();
  const source = await lstat(sourceRoot).catch(() => { throw refused(); }); if (!source.isDirectory() || source.isSymbolicLink()) throw refused();
  if (!request) await liveRuntimeAndSource(sourceRoot, expectedSha);
  const directory = await privateDir(privatePath); const manifestFile = await privateFile(manifestPath, directory, true); const report = await privateFile(reportPath, directory, false);
  const files = parseManifest(JSON.parse(await readFile(manifestFile, "utf8")), expectedSha);
  const api = request ?? ((endpoint) => liveRequest({ endpoint, teamId }));
  const deployment = await api(`/v13/deployments/${deploymentId}`); metadata(deployment, expectedSha, deploymentId, projectId, teamId, deploymentUrl);
  const tree = await api(`/v6/deployments/${deploymentId}/files`); const providerFiles = flatten(tree).sort((a, b) => a.path.localeCompare(b.path));
  if (providerFiles.length !== files.length || providerFiles.some((file, index) => file.path !== files[index].path)) throw refused();
  const verified = [];
  for (let index = 0; index < providerFiles.length; index += 1) {
    const provider = providerFiles[index]; const bytes = decoded(pointer(await api(`/v8/deployments/${deploymentId}/files/${provider.uid}`), base64Pointer));
    const local = files[index]; if (bytes.length !== local.size || createHash("sha256").update(bytes).digest("hex") !== local.sha256) throw refused();
    verified.push({ path: local.path, type: "file", sha256: local.sha256, size: local.size, cliSha: local.cliSha, cliMode: local.cliMode, apiMode: provider.apiMode });
  }
  const result = { schemaVersion: 1, kind: "jobtracker-preview-deployment-byte-report", deploymentId, projectId, teamId, sourceSha: expectedSha, apiMode: "vercel-cli-read-only", files: verified };
  await writeFile(report, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(() => { throw refused(); }); return result;
}
function args(values) { if (values.length !== 20) throw refused(); const flags = ["--source-root", "--expected-sha", "--private-dir", "--manifest", "--report", "--deployment-id", "--project-id", "--team-id", "--deployment-url", "--base64-pointer"]; const out = {}; for (let i = 0; i < values.length; i += 2) { if (values[i] !== flags.find((flag) => flag === values[i]) || Object.hasOwn(out, values[i]) || !values[i + 1] || values[i + 1].startsWith("--")) throw refused(); out[values[i]] = values[i + 1]; } return { sourceRoot: out["--source-root"], expectedSha: out["--expected-sha"], privateDir: out["--private-dir"], manifestPath: out["--manifest"], reportPath: out["--report"], deploymentId: out["--deployment-id"], projectId: out["--project-id"], teamId: out["--team-id"], deploymentUrl: out["--deployment-url"], base64Pointer: out["--base64-pointer"] }; }
if (import.meta.url === new URL(process.argv[1], "file:").href) verifyDeploymentBytes(args(process.argv.slice(2))).then(() => process.stdout.write("Preview deployment bytes verified.\n")).catch(() => { process.stderr.write("Preview deployment byte verifier refused.\n"); process.exitCode = 1; });
