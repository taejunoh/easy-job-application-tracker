import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const sha = "5e5610944698e18230c8e67378dda35d8eb311f8";
const { verifyDeploymentBytes } = await import(join(ROOT, "scripts/verify-preview-deployment-bytes.mjs"));

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "preview-byte-verifier-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function input(directory) {
  const privateDir = join(directory, "private");
  await mkdir(privateDir, { mode: 0o700 }); await chmod(privateDir, 0o700);
  const manifestPath = join(privateDir, "manifest.json");
  const manifest = { schemaVersion: 1, kind: "jobtracker-vercel-upload-manifest", sourceSha: sha, files: [
    { path: "a.txt", type: "file", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", size: 5, cliSha: "a".repeat(40), cliMode: 33188 },
    { path: "nested/b.txt", type: "file", sha256: "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7", size: 5, cliSha: "b".repeat(40), cliMode: 33188 },
  ] };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 }); await chmod(manifestPath, 0o600);
  return { privateDir, manifestPath, reportPath: join(privateDir, "report.json") };
}

function responses({ tree = validTree(), deployment = validDeployment(), contents = { u1: { payload: { body: Buffer.from("hello").toString("base64") } }, u2: { payload: { body: Buffer.from("world").toString("base64") } } } } = {}) {
  return async (endpoint) => {
    if (endpoint === "/v13/deployments/dpl_fixture") return deployment;
    if (endpoint === "/v6/deployments/dpl_fixture/files") return tree;
    const uid = endpoint.match(/^\/v8\/deployments\/dpl_fixture\/files\/(.+)$/u)?.[1];
    if (uid && Object.hasOwn(contents, uid)) return contents[uid];
    throw new Error("unexpected request");
  };
}

function validDeployment() {
  return { id: "dpl_fixture", target: null, readyState: "READY", url: "fixture.vercel.app", projectId: "prj_fixture", ownerId: "team_fixture", project: { id: "prj_fixture" }, team: { id: "team_fixture" }, meta: { gitCommitSha: sha }, gitMetadata: {} };
}

function validTree() {
  return { type: "directory", children: [
    { type: "file", name: "a.txt", uid: "u1", mode: 100600 },
    { type: "directory", name: "nested", children: [{ type: "file", name: "b.txt", uid: "u2", mode: 100755 }] },
  ] };
}

async function verify(directory, options = {}) {
  const paths = await input(directory);
  return verifyDeploymentBytes({ sourceRoot: directory, expectedSha: sha, privateDir: paths.privateDir, manifestPath: paths.manifestPath, reportPath: paths.reportPath, deploymentId: "dpl_fixture", projectId: "prj_fixture", teamId: "team_fixture", deploymentUrl: "https://fixture.vercel.app", base64Pointer: "/payload/body", request: responses(options) });
}

test("accepts a complete nested provider tree only when every decoded byte matches the captured upload manifest", async () => {
  await temporary(async (directory) => {
    const result = await verify(directory);
    assert.equal(result.files.length, 2);
    assert.deepEqual(result.files.map((file) => [file.path, file.apiMode]), [["a.txt", 100600], ["nested/b.txt", 100755]]);
    const report = JSON.parse(await readFile(join(directory, "private", "report.json"), "utf8"));
    assert.equal(report.sourceSha, sha);
    assert.equal(JSON.stringify(report).includes("aGVsbG8="), false);
    assert.equal((await (await import("node:fs/promises")).lstat(join(directory, "private", "report.json"))).mode & 0o777, 0o600);
  });
});

test("refuses deployment responses outside the exact Ready Preview project/team URL contract", async () => {
  const cases = [
    ["wrong id", { id: "dpl_other" }], ["production target", { target: "production" }], ["staging target", { target: "staging" }], ["unknown state", { readyState: "BUILDING" }],
    ["wrong nested project", { project: { id: "prj_other" } }], ["wrong nested team", { team: { id: "team_other" } }], ["wrong URL", { url: "other.vercel.app" }],
    ["inconsistent top-level project", { projectId: "prj_other" }], ["inconsistent top-level owner", { ownerId: "team_other" }],
  ];
  for (const [name, change] of cases) await temporary(async (directory) => {
    await assert.rejects(verify(directory, { deployment: { ...validDeployment(), ...change } }), /refused/u, name);
  });
});

test("refuses incomplete, extra, duplicate, unsupported, invalid-base64, mismatched-byte, unconfigured-envelope, and bad-SHA-metadata responses", async () => {
  const cases = [
    ["missing path", { tree: { type: "directory", children: [{ type: "file", name: "a.txt", uid: "u1", mode: 1 }] } }],
    ["extra path", { tree: { type: "directory", children: [...validTree().children, { type: "file", name: "extra.txt", uid: "u3", mode: 1 }] } }],
    ["duplicate uid", { tree: { type: "directory", children: [{ type: "file", name: "a.txt", uid: "u1", mode: 1 }, { type: "file", name: "nested", uid: "u1", mode: 1 }] } }],
    ["unsupported type", { tree: { type: "directory", children: [{ type: "symlink", name: "a.txt", uid: "u1", mode: 1 }] } }],
    ["invalid base64", { contents: { u1: { payload: { body: "***" } }, u2: { payload: { body: Buffer.from("world").toString("base64") } } } }],
    ["byte mismatch", { contents: { u1: { payload: { body: Buffer.from("wrong").toString("base64") } }, u2: { payload: { body: Buffer.from("world").toString("base64") } } } }],
    ["unexpected content envelope", { contents: { u1: { data: { body: Buffer.from("hello").toString("base64") } }, u2: { payload: { body: Buffer.from("world").toString("base64") } } } }],
    ["missing all SHA metadata", { deployment: { ...validDeployment(), meta: {}, gitMetadata: {} } }],
    ["conflicting populated SHA metadata", { deployment: { ...validDeployment(), gitMetadata: { commitSha: "f".repeat(40) } } }],
    ["malformed native SHA metadata", { deployment: { ...validDeployment(), meta: { gitCommitSha: "not-a-sha" } } }],
  ];
  for (const [name, options] of cases) {
    await temporary(async (directory) => {
      await assert.rejects(verify(directory, options), /refused/u, name);
      await assert.rejects(readFile(join(directory, "private", "report.json"), "utf8"));
    });
  }
});
