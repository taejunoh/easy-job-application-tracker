import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(join(__dirname, "../../scripts/local-container-start.mjs")).href;
const valid = {
  NODE_ENV: "production", LOCAL_DOCKER_HTTP_ENABLED: "1",
  POSTGRES_PASSWORD: "c".repeat(64), DATABASE_URL: `postgresql://jobtracker:${"c".repeat(64)}@db:5432/jobtracker`,
  ENCRYPTION_SECRET: "e".repeat(64), APP_ACCESS_TOKEN: "a".repeat(64),
  APP_BASE_URL: "http://127.0.0.1:3000", CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
  APPLICATION_WRITES_ENABLED: "1", APPLICATION_IDENTITY_WRITES_ENABLED: "0", VALIDATION_MANUAL_ENTRY_ENABLED: "0",
};
function run(overrides = {}, migrationStatus = 0, failure?: "throw" | "error") {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { startLocalContainer } from ${JSON.stringify(moduleUrl)};
    import { EventEmitter } from "node:events";
    const chunks=[]; for await (const c of process.stdin) chunks.push(c);
    const input=JSON.parse(Buffer.concat(chunks).toString()), calls=[], errors=[];
    const status=await startLocalContainer({ env: input.env, stderr: value=>errors.push(value),
      run: (command,args)=>{ calls.push({command,args});
        if (input.failure === "throw") throw new Error("SENSITIVE_DATABASE_URL");
        const child = new EventEmitter(); child.kill = () => true;
        queueMicrotask(() => input.failure === "error" ? child.emit("error", new Error("SENSITIVE_DATABASE_URL")) : child.emit("close", calls.length===1 ? input.migrationStatus : 0, null)); return child; } });
    process.stdout.write(JSON.stringify({status,calls,errors}));
  `], { input: JSON.stringify({ env: { ...valid, ...overrides }, migrationStatus, failure }), encoding: "utf8" });
  expect(result.status).toBe(0); return JSON.parse(result.stdout);
}
describe("local container migration boundary", () => {
  it("migrates only the owned database before the normal production entrypoint", () => {
    const result = run(); expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      { command: process.execPath, args: ["node_modules/prisma/build/index.js", "migrate", "deploy"] },
      { command: process.execPath, args: ["--import", "./scripts/validate-startup-env-production.mjs", "node_modules/next/dist/bin/next", "start"] },
    ]);
  });
  it.each([
    { LOCAL_DOCKER_HTTP_ENABLED: "0" }, { NODE_ENV: "development" },
    { DATABASE_URL: valid.DATABASE_URL.replace("@db:", "@remote.example:") },
    { DATABASE_URL: valid.DATABASE_URL + "?schema=other" },
    { DATABASE_URL: valid.DATABASE_URL + "#fragment" },
    { DATABASE_URL: valid.DATABASE_URL.replace("5432", "5433") },
    { DATABASE_URL: valid.DATABASE_URL.replace("postgresql://jobtracker:", "postgresql://other:") },
    { POSTGRES_PASSWORD: "b".repeat(64) },
  ])("refuses unsafe migration target or mode: %j", (overrides) => {
    const result = run(overrides); expect(result.status).toBe(1); expect(result.calls).toEqual([]);
    expect(result.errors.join()).not.toContain("remote.example"); expect(result.errors.join()).not.toContain(valid.POSTGRES_PASSWORD);
  });
  it("does not launch Next after migration failure or reveal raw subprocess diagnostics", () => {
    const result = run({}, 1); expect(result.status).toBe(1); expect(result.calls).toHaveLength(1);
    expect(result.errors.join()).toMatch(/migration/i); expect(result.errors.join()).not.toContain("SENSITIVE_DATABASE_URL");
  });
  it.each(["throw", "error"] as const)("sanitizes migration spawn %s and never launches Next", (failure) => {
    const result = run({}, 0, failure);
    expect(result.status).toBe(1); expect(result.calls).toHaveLength(1);
    expect(result.errors.join()).toMatch(/migration/i);
    expect(result.errors.join()).not.toContain("SENSITIVE_DATABASE_URL");
  });
});
