import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { resolve } from "node:path";

import pg from "pg";

import {
  E2E_ACCESS_TOKEN,
  E2E_CONFIGURED_APP_ORIGIN,
  E2E_ENCRYPTION_SECRET,
} from "./extension-e2e-fixtures.mjs";

const { Client } = pg;
const root = resolve(import.meta.dirname, "..");
const databaseName = "jobtracker_extension_e2e_test";
const adminUrl =
  process.env.EXTENSION_E2E_POSTGRES_ADMIN_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const state = {
  admin: null,
  child: null,
  ownsDatabase: false,
};
let cleanupPromise = null;
let handlingSignal = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (handlingSignal) return;
    handlingSignal = true;
    if (state.child?.exitCode === null) state.child.kill(signal);
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

try {
  const target = assertSafeAdminUrl(adminUrl);
  const admin = new Client({ connectionString: adminUrl });
  state.admin = admin;
  await admin.connect();
  const identity = await verifyPostgres17(admin, target);
  const existing = await admin.query(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [databaseName],
  );
  if (existing.rows[0]?.exists === true) {
    throw new Error("Refusing extension E2E: disposable database already exists");
  }

  await admin.query(`CREATE DATABASE ${quotedDatabaseName()}`);
  state.ownsDatabase = true;

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const childEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    RUN_EXTENSION_E2E: "1",
    ALLOW_DESTRUCTIVE_EXTENSION_E2E:
      "jobtracker-extension-e2e-delete-all",
    DATABASE_URL: databaseUrl.toString(),
    EXPECTED_DATABASE_SERVER_ADDRESS: identity.address,
    ENCRYPTION_SECRET: E2E_ENCRYPTION_SECRET,
    APP_ACCESS_TOKEN: E2E_ACCESS_TOKEN,
    APP_BASE_URL: E2E_CONFIGURED_APP_ORIGIN,
    CORS_ALLOWED_ORIGINS:
      `${E2E_CONFIGURED_APP_ORIGIN},` +
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  };
  delete childEnvironment.EXTENSION_E2E_POSTGRES_ADMIN_URL;

  await runChild("npm", ["run", "build"], childEnvironment);
  await runChild(
    process.execPath,
    [resolve(root, "scripts/extension-e2e.mjs")],
    childEnvironment,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Local extension E2E failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}

function assertSafeAdminUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Refusing extension E2E: invalid local PostgreSQL admin URL");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    !/^[0-9]+$/u.test(url.port) ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Refusing extension E2E: unsafe PostgreSQL admin target");
  }
  return Object.freeze({ host: url.hostname, port: Number(url.port) });
}

async function verifyPostgres17(admin, target) {
  const result = await admin.query(
    "SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::integer AS version",
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.database !== "postgres" ||
    typeof row?.address !== "string" ||
    isIP(row.address) === 0 ||
    row.port !== target.port ||
    row.version < 170_000 ||
    row.version >= 180_000
  ) {
    throw new Error("Refusing extension E2E: live PostgreSQL 17 identity mismatch");
  }
  return Object.freeze({ address: row.address });
}

async function runChild(command, args, environment) {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  state.child = child;
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  state.child = null;
  if (result.code !== 0) {
    throw new Error("Local extension E2E child command failed");
  }
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (state.child?.exitCode === null) {
      state.child.kill("SIGTERM");
    }
    if (state.admin && state.ownsDatabase) {
      try {
        await state.admin.query(
          `DROP DATABASE IF EXISTS ${quotedDatabaseName()} WITH (FORCE)`,
        );
        state.ownsDatabase = false;
      } catch {
        process.exitCode = 1;
      }
    }
    if (state.admin) {
      try {
        await state.admin.end();
      } catch {
        process.exitCode = 1;
      }
      state.admin = null;
    }
  })();
  return cleanupPromise;
}

function quotedDatabaseName() {
  return `"${databaseName}"`;
}
