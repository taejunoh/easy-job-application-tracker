import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Startup verification must run through npm");
}
await access(join(root, ".next", "BUILD_ID"));

const MANAGED_ENV_NAMES = [
  "DATABASE_URL",
  "ENCRYPTION_SECRET",
  "APP_ACCESS_TOKEN",
  "APP_BASE_URL",
  "CORS_ALLOWED_ORIGINS",
  "APPLICATION_WRITES_ENABLED",
  "NODE_ENV",
];
const VALID_ENV = Object.freeze({
  DATABASE_URL:
    "postgresql://startup:startup@127.0.0.1:5432/jobtracker_startup_test",
  ENCRYPTION_SECRET: "startup-encryption-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  APP_ACCESS_TOKEN: "startup-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  APP_BASE_URL: "https://jobtracker.test",
  CORS_ALLOWED_ORIGINS: "https://jobtracker.test",
  APPLICATION_WRITES_ENABLED: "1",
});
const VALID_DEVELOPMENT_ENV = Object.freeze({
  ...VALID_ENV,
  APP_BASE_URL: "http://localhost:3000",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
});
const PRIVATE_INVALID_SECRET = "never-print-this-secret";

await verifyScenario({
  name: "valid .env production start",
  files: { ".env": envFile(VALID_ENV) },
  command: "start",
  expected: "ready",
});
await verifyScenario({
  name: "invalid .env production start",
  files: {
    ".env": envFile({
      ...VALID_ENV,
      ENCRYPTION_SECRET: PRIVATE_INVALID_SECRET,
    }),
  },
  command: "start",
  expected: "failure",
});
await verifyScenario({
  name: ".env.production precedence",
  files: {
    ".env": envFile(VALID_ENV),
    ".env.production": envFile({
      ...VALID_ENV,
      ENCRYPTION_SECRET: PRIVATE_INVALID_SECRET,
    }),
  },
  command: "start",
  expected: "failure",
});
await verifyScenario({
  name: "explicit environment precedence",
  files: {
    ".env.production": envFile({
      ...VALID_ENV,
      ENCRYPTION_SECRET: PRIVATE_INVALID_SECRET,
    }),
  },
  explicitEnv: VALID_ENV,
  command: "start",
  expected: "ready",
});
await verifyScenario({
  name: "valid .env.development dev start",
  files: { ".env.development": envFile(VALID_DEVELOPMENT_ENV) },
  command: "dev",
  expected: "ready",
});
await verifyScenario({
  name: "invalid .env.development dev start",
  files: {
    ".env": envFile(VALID_ENV),
    ".env.development": envFile({
      ...VALID_ENV,
      ENCRYPTION_SECRET: PRIVATE_INVALID_SECRET,
    }),
  },
  command: "dev",
  expected: "failure",
});

async function verifyScenario({
  name,
  files,
  explicitEnv = {},
  command,
  expected,
}) {
  const checkout = await createTemporaryCheckout(files, command);
  const port = await availablePort();
  const execution = startNpmCommand(checkout, command, port, explicitEnv);

  try {
    const outcome = await execution.firstOutcome;
    if (expected === "ready") {
      if (outcome.kind !== "ready") {
        throw new Error(`${name} exited before Ready: ${execution.output()}`);
      }
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/connect`);
      } catch (cause) {
        throw new Error(
          `${name} request failed after Ready: ${execution.output()}`,
          { cause },
        );
      }
      if (response.status !== 200) {
        throw new Error(`${name} returned HTTP ${response.status}`);
      }
      assertSecretsAreNotLogged(name, execution.output());
      terminate(execution.child, "SIGTERM");
      await execution.closed;
      return;
    }

    if (outcome.kind === "ready") {
      throw new Error(`${name} reached Next.js Ready state`);
    }
    if (outcome.kind === "timeout") {
      throw new Error(`${name} did not terminate within 10 seconds`);
    }
    if (outcome.code === 0 || outcome.signal !== null) {
      throw new Error(`${name} ended unexpectedly: ${execution.output()}`);
    }
    if (
      !execution
        .output()
        .includes("Invalid server environment variable ENCRYPTION_SECRET")
    ) {
      throw new Error(`${name} did not report the safe validation error`);
    }
    assertSecretsAreNotLogged(name, execution.output());
  } finally {
    terminate(execution.child, "SIGKILL");
    await execution.closed;
    await rm(checkout, { recursive: true, force: true });
  }
}

async function createTemporaryCheckout(files, command) {
  const checkout = await mkdtemp(join(root, ".jobtracker-startup-"));
  await mkdir(join(checkout, "scripts"), { recursive: true });
  if (command === "start") {
    await mkdir(join(checkout, "src", "lib"), { recursive: true });
  }
  await Promise.all([
    copyFile(join(root, "package.json"), join(checkout, "package.json")),
    copyFile(
      join(root, "scripts", "load-and-validate-startup-env.mjs"),
      join(checkout, "scripts", "load-and-validate-startup-env.mjs"),
    ),
    copyFile(
      join(root, "scripts", "validate-startup-env-development.mjs"),
      join(checkout, "scripts", "validate-startup-env-development.mjs"),
    ),
    copyFile(
      join(root, "scripts", "validate-startup-env-production.mjs"),
      join(checkout, "scripts", "validate-startup-env-production.mjs"),
    ),
    symlink(join(root, "node_modules"), join(checkout, "node_modules"), "dir"),
    ...(command === "start"
      ? [
          copyFile(
            join(root, "src", "lib", "server-env-core.js"),
            join(checkout, "src", "lib", "server-env-core.js"),
          ),
          symlink(join(root, ".next"), join(checkout, ".next"), "dir"),
        ]
      : [
          cp(join(root, "src"), join(checkout, "src"), { recursive: true }),
          copyFile(
            join(root, "next.config.ts"),
            join(checkout, "next.config.ts"),
          ),
          copyFile(join(root, "tsconfig.json"), join(checkout, "tsconfig.json")),
          copyFile(
            join(root, "postcss.config.mjs"),
            join(checkout, "postcss.config.mjs"),
          ),
        ]),
    ...Object.entries(files).map(([name, contents]) =>
      writeFile(join(checkout, name), contents, { mode: 0o600 }),
    ),
  ]);
  return checkout;
}

function startNpmCommand(checkout, command, port, explicitEnv) {
  const env = { ...process.env };
  for (const name of MANAGED_ENV_NAMES) delete env[name];
  Object.assign(env, explicitEnv);

  const child = spawn(
    process.execPath,
    [npmCli, "run", command, "--", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: checkout,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const capture = (chunk) => {
    output += chunk.toString();
    if (/\bReady in\b/u.test(output)) ready();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), 10_000);
    timer.unref?.();
    closed.finally(() => clearTimeout(timer));
  });
  const firstOutcome = Promise.race([
    readyPromise.then(() => ({ kind: "ready" })),
    closed.then(({ code, signal }) => ({ kind: "exit", code, signal })),
    timeout,
  ]);

  return { child, closed, firstOutcome, output: () => output };
}

function terminate(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertSecretsAreNotLogged(name, output) {
  for (const secret of [
    VALID_ENV.DATABASE_URL,
    VALID_ENV.ENCRYPTION_SECRET,
    VALID_ENV.APP_ACCESS_TOKEN,
    PRIVATE_INVALID_SECRET,
  ]) {
    if (output.includes(secret)) {
      throw new Error(`${name} exposed secret material in startup output`);
    }
  }
}

function envFile(values) {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) {
          reject(new Error("Could not reserve a startup test port"));
        } else resolve(port);
      });
    });
  });
}
