import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

const { Client } = pg;
const root = join(__dirname, "../..");
const wrapper = join(root, "scripts/extension-e2e-local.mjs");
const databaseName = "jobtracker_extension_e2e_test";
const adminUrl = "postgresql://postgres@127.0.0.1:5432/postgres";
const requested = process.env.RUN_EXTENSION_E2E_SIGNAL_INTEGRATION === "1";
const describeSignal = requested ? describe : describe.skip;

type ChildResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type ReadyState = Readonly<{
  wrapperPid: number;
  parentPid: number;
  grandchildPid: number;
  marker: string;
}>;

function runWrapper(environment: NodeJS.ProcessEnv): {
  child: ChildProcessWithoutNullStreams;
  result: Promise<ChildResult>;
} {
  const child = spawn(process.execPath, [wrapper], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const result = new Promise<ChildResult>((resolveResult) => {
    child.once("close", (code, signal) =>
      resolveResult({ code, signal, stdout, stderr }),
    );
  });
  return { child, result };
}

function runNpmCommand(environment: NodeJS.ProcessEnv): {
  child: ChildProcessWithoutNullStreams;
  result: Promise<ChildResult>;
} {
  const child = spawn("npm", ["run", "test:extension:e2e:local"], {
    cwd: root,
    detached: true,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const result = new Promise<ChildResult>((resolveResult) => {
    child.once("close", (code, signal) =>
      resolveResult({ code, signal, stdout, stderr }),
    );
  });
  return { child, result };
}

async function waitForFile(path: string, result: Promise<ChildResult>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      const ended = await Promise.race([
        result.then(() => true),
        new Promise<false>((resolveWait) =>
          setTimeout(() => resolveWait(false), 20),
        ),
      ]);
      if (ended)
        throw new Error("local wrapper exited before fixture was ready");
    }
  }
  throw new Error("timed out waiting for local wrapper signal fixture");
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`fixture process ${pid} remained after wrapper exit`);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function resultWithin(result: Promise<ChildResult>, timeout: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("npm command streams remained open")),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function profileWorkspaces(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("jobtracker-extension-e2e-"))
    .sort();
}

describeSignal("local extension E2E signal cleanup", () => {
  jest.setTimeout(30_000);

  it.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("handles %s after draining the build process group", async (signal, exitCode) => {
    const controlDirectory = await mkdtemp(
      join(tmpdir(), "jobtracker-extension-e2e-signal-test-"),
    );
    const readyPath = join(controlDirectory, "ready.json");
    const tracePath = join(controlDirectory, "signals.log");
    const marker = `jobtracker-extension-e2e-signal-${signal}-${process.pid}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const beforeProfiles = await profileWorkspaces();
    const existing = await admin.query(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName],
    );
    expect(existing.rows[0]?.exists).toBe(false);

    const { child, result } = runWrapper({
      ...process.env,
      EXTENSION_E2E_POSTGRES_ADMIN_URL: adminUrl,
      EXTENSION_E2E_LOCAL_SIGNAL_FIXTURE: "1",
      RUN_EXTENSION_E2E_SIGNAL_INTEGRATION: "1",
      EXTENSION_E2E_SIGNAL_READY_PATH: readyPath,
      EXTENSION_E2E_SIGNAL_TRACE_PATH: tracePath,
      EXTENSION_E2E_SIGNAL_MARKER: marker,
    });
    let ready: ReadyState | null = null;
    try {
      await waitForFile(readyPath, result);
      ready = JSON.parse(await readFile(readyPath, "utf8")) as ReadyState;
      expect(ready.marker).toBe(marker);
      const created = await admin.query(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [databaseName],
      );
      expect(created.rows[0]?.exists).toBe(true);

      child.kill(signal);
      const completed = await resultWithin(result, 5_000);
      expect(completed).toMatchObject({ code: exitCode, signal: null });
      expect(completed.stderr).toBe("");
      expect(await readFile(tracePath, "utf8")).toBe(`${signal}:first\n`);
      await waitForProcessExit(ready.parentPid);
      await waitForProcessExit(ready.grandchildPid);

      const removed = await admin.query(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [databaseName],
      );
      expect(removed.rows[0]?.exists).toBe(false);
      expect(await profileWorkspaces()).toEqual(beforeProfiles);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      if (ready?.parentPid) {
        try {
          process.kill(-ready.parentPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await admin.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await admin.end();
      await rm(controlDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "cleans up when the exact npm command process group receives %s",
    async (signal, exitCode) => {
      const controlDirectory = await mkdtemp(
        join(tmpdir(), "jobtracker-extension-e2e-npm-signal-test-"),
      );
      const readyPath = join(controlDirectory, "ready.json");
      const tracePath = join(controlDirectory, "signals.log");
      const marker = `jobtracker-extension-e2e-npm-signal-${signal}-${process.pid}`;
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      const beforeProfiles = await profileWorkspaces();
      const existing = await admin.query(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [databaseName],
      );
      expect(existing.rows[0]?.exists).toBe(false);

      const { child, result } = runNpmCommand({
        ...process.env,
        EXTENSION_E2E_POSTGRES_ADMIN_URL: adminUrl,
        EXTENSION_E2E_LOCAL_SIGNAL_FIXTURE: "1",
        RUN_EXTENSION_E2E_SIGNAL_INTEGRATION: "1",
        EXTENSION_E2E_SIGNAL_READY_PATH: readyPath,
        EXTENSION_E2E_SIGNAL_TRACE_PATH: tracePath,
        EXTENSION_E2E_SIGNAL_MARKER: marker,
      });
      let ready: ReadyState | null = null;
      try {
        await waitForFile(readyPath, result);
        ready = JSON.parse(await readFile(readyPath, "utf8")) as ReadyState;
        expect(ready.marker).toBe(marker);
        const created = await admin.query(
          "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
          [databaseName],
        );
        expect(created.rows[0]?.exists).toBe(true);

        process.kill(-child.pid!, signal);
        let completed: ChildResult;
        try {
          completed = await resultWithin(result, 5_000);
        } catch (error) {
          const trace = await readFile(tracePath, "utf8").catch(
            () => "missing",
          );
          const survivors = {
            npm: processExists(child.pid!),
            wrapper: processExists(ready.wrapperPid),
            parent: processExists(ready.parentPid),
            grandchild: processExists(ready.grandchildPid),
          };
          throw new Error(
            `${(error as Error).message}; signal trace: ${trace}; survivors: ${JSON.stringify(survivors)}`,
          );
        }
        expect(
          (completed.code === exitCode && completed.signal === null) ||
            (completed.code === null && completed.signal === signal),
        ).toBe(true);
        expect(await readFile(tracePath, "utf8")).toBe(
          `${signal}:first\n${signal}:additional\n`,
        );
        await waitForProcessExit(ready.wrapperPid);
        await waitForProcessExit(ready.parentPid);
        await waitForProcessExit(ready.grandchildPid);

        const removed = await admin.query(
          "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
          [databaseName],
        );
        expect(removed.rows[0]?.exists).toBe(false);
        expect(await profileWorkspaces()).toEqual(beforeProfiles);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        if (ready?.parentPid) {
          try {
            process.kill(-ready.parentPid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
        await admin.end();
        await rm(controlDirectory, { recursive: true, force: true });
      }
    },
  );
});
