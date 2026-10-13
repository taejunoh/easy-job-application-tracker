import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateOwnedDatabase } from "./local-setup-core.mjs";
import serverEnvCore from "../src/lib/server-env-core.js";

export async function startLocalContainer({ env = process.env, run = spawn, shutdownTimeoutMs = 5000,
  stderr = value => process.stderr.write(`${value}\n`) } = {}) {
  try {
    if (env.NODE_ENV !== "production" || env.LOCAL_DOCKER_HTTP_ENABLED !== "1") throw new Error();
    validateOwnedDatabase(env);
    serverEnvCore.validateServerEnv(env, "production");
  } catch {
    stderr("Local startup refused: production local Docker mode and its isolated database are required.");
    return 1;
  }
  let activeChild;
  let requestedSignal;
  let terminationTimer;
  const signalStatus = () => requestedSignal === "SIGINT" ? 130 : 143;
  const forwardSignal = signal => {
    if (requestedSignal) return;
    requestedSignal = signal;
    if (!activeChild) return;
    const child = activeChild;
    child.kill(signal);
    terminationTimer = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
  };
  const onTerm = () => forwardSignal("SIGTERM");
  const onInt = () => forwardSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const runChild = (args, stdio) => new Promise(resolve => {
    let child;
    try { child = run(process.execPath, args, { env, stdio }); }
    catch { resolve(1); return; }
    activeChild = child;
    const finish = status => {
      clearTimeout(terminationTimer);
      activeChild = undefined;
      resolve(status);
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code === 0 ? 0 : 1));
  });
  try {
    const migration = await runChild(["node_modules/prisma/build/index.js", "migrate", "deploy"], "ignore");
    if (requestedSignal) return signalStatus();
    if (migration !== 0) {
      stderr("Local database migration failed. The application was not started. Retry after checking the local database; saved data and credentials were preserved.");
      return 1;
    }
    // Launch Next directly so the production preload and shutdown signal reach the same child.
    const status = await runChild([
      "--import", "./scripts/validate-startup-env-production.mjs",
      "node_modules/next/dist/bin/next", "start",
    ], "inherit");
    return requestedSignal ? signalStatus() : status;
  } finally {
    clearTimeout(terminationTimer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await startLocalContainer();
}
