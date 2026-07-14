import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
await access(join(root, ".next", "BUILD_ID"));

const port = await availablePort();
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Startup verification must run through npm");
}
const child = spawn(
  process.execPath,
  [npmCli, "start", "--", "-H", "127.0.0.1", "-p", String(port)],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL:
        "postgresql://startup:startup@127.0.0.1:5432/jobtracker_startup_test",
      ENCRYPTION_SECRET: "short",
      APP_ACCESS_TOKEN: "startup-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      APP_BASE_URL: "https://jobtracker.test",
      CORS_ALLOWED_ORIGINS: "https://jobtracker.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
let ready = false;
let timedOut = false;
const capture = (chunk) => {
  output += chunk.toString();
  if (/\bReady in\b/u.test(output)) {
    ready = true;
    child.kill("SIGTERM");
  }
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, 10_000);
timeout.unref?.();

const { code, signal } = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (exitCode, exitSignal) =>
    resolve({ code: exitCode, signal: exitSignal }),
  );
});
clearTimeout(timeout);

if (timedOut) {
  throw new Error("Invalid deployment did not terminate within 10 seconds");
}
if (ready) {
  throw new Error("Invalid deployment reached Next.js Ready state");
}
if (code === 0 || signal !== null) {
  throw new Error(`Invalid deployment ended unexpectedly: ${output}`);
}
if (!output.includes("Invalid server environment variable ENCRYPTION_SECRET")) {
  throw new Error(`Startup did not report the expected safe validation error: ${output}`);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null
        ? address.port
        : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("Could not reserve a startup test port"));
        else resolve(port);
      });
    });
  });
}
