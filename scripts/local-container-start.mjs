import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateOwnedDatabase } from "./local-setup-core.mjs";
import serverEnvCore from "../src/lib/server-env-core.js";

export async function startLocalContainer({ env = process.env, run = spawnSync,
  stderr = value => process.stderr.write(`${value}\n`) } = {}) {
  try {
    if (env.NODE_ENV !== "production" || env.LOCAL_DOCKER_HTTP_ENABLED !== "1") throw new Error();
    validateOwnedDatabase(env);
    serverEnvCore.validateServerEnv(env, "production");
  } catch {
    stderr("Local startup refused: production local Docker mode and its isolated database are required.");
    return 1;
  }
  let migration;
  try { migration = run("node", ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); }
  catch { migration = { status: 1 }; }
  if (migration.status !== 0 || migration.error) {
    stderr("Local database migration failed. The application was not started. Retry after checking the local database; saved data and credentials were preserved.");
    return 1;
  }
  // Normal npm start retains the existing production environment validation.
  try {
    const result = run("npm", ["start"], { env, stdio: "inherit" });
    return result.status === 0 && !result.error ? 0 : 1;
  } catch { stderr("Local application startup failed."); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await startLocalContainer();
}
