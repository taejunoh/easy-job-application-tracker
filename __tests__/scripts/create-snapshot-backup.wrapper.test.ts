import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(__dirname, "../..");
const coordinator = join(root, "scripts/create-snapshot-backup.mjs");

type Result = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { child: ReturnType<typeof spawn>; result: Promise<Result> } {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const result = new Promise<Result>((resolve) => {
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, result };
}

async function boundedResult(
  result: Promise<Result>,
  timeoutMs: number,
): Promise<Result | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const settled = await Promise.race([result, timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("Docker snapshot dump wrapper", () => {
  it("fails closed when its control-loop command cannot run", async () => {
    const wrapperModule = pathToFileURL(coordinator).href;
    const wrapperExecution = run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DOCKER_DUMP_WRAPPER } from ${JSON.stringify(wrapperModule)}; process.stdout.write(DOCKER_DUMP_WRAPPER);`,
      ],
      process.env,
    );
    const wrapperResult = await wrapperExecution.result;
    expect(wrapperResult).toMatchObject({ code: 0, signal: null });

    const runDirectory = await mkdtemp(join(tmpdir(), "jobtracker-wrapper-"));
    const pidPath = join(runDirectory, "dump.pid");
    const startPath = join(runDirectory, "dump.start");
    const cancelPath = join(runDirectory, "dump.cancel");
    const shell = run(
      "/bin/sh",
      [
        "-c",
        wrapperResult.stdout,
        "jobtracker-backup",
        pidPath,
        startPath,
        cancelPath,
      ],
      { ...process.env, PATH: join(runDirectory, "no-such-bin") },
    );

    try {
      await waitForFile(pidPath);
      const result = await boundedResult(shell.result, 1_000);
      if (result === "timeout") shell.child.kill("SIGKILL");
      expect(result).toMatchObject({ code: 127, signal: null });
    } finally {
      if (shell.child.exitCode === null) shell.child.kill("SIGKILL");
      await shell.result;
      await rm(runDirectory, { recursive: true, force: true });
    }
  });
});
