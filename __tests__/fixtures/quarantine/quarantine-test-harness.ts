import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const transactionUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-transaction.mjs"),
).href;

export type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  branch: string;
  head: string;
  expectedCount: number;
  historyHead?: string;
  canonicalPath?: string;
  copyPath?: string;
};

function git(repoRoot: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function createQuarantineFixture({
  divergent = false,
  repoName = "repo",
  canonicalPath = "notes.txt",
  copyPath = "notes 2.txt",
}: {
  divergent?: boolean;
  repoName?: string;
  canonicalPath?: string;
  copyPath?: string;
} = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "quarantine-transaction-"));
  const repoRoot = join(base, repoName);
  const quarantineRoot = join(base, "quarantine");
  privateDirectory(repoRoot);
  privateDirectory(quarantineRoot);
  git(repoRoot, "init", "-b", "slice-one");
  git(repoRoot, "config", "user.name", "Test User");
  git(repoRoot, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoRoot, ".gitignore"), ".next/\nnode_modules/\n");
  mkdirSync(dirname(join(repoRoot, canonicalPath)), { recursive: true });
  writeFileSync(join(repoRoot, canonicalPath), "canonical\n");
  git(repoRoot, "add", ".gitignore", canonicalPath);
  git(repoRoot, "commit", "-m", "fixture");
  const historyHead = divergent ? git(repoRoot, "rev-parse", "HEAD") : undefined;
  if (divergent) {
    writeFileSync(join(repoRoot, canonicalPath), "new canonical\n");
    git(repoRoot, "add", canonicalPath);
    git(repoRoot, "commit", "-m", "change canonical");
  }
  mkdirSync(dirname(join(repoRoot, copyPath)), { recursive: true });
  writeFileSync(join(repoRoot, copyPath), "canonical\n");
  privateDirectory(join(repoRoot, ".next"));
  privateDirectory(join(repoRoot, "node_modules"));
  writeFileSync(join(repoRoot, ".next", "build"), "ignored");
  writeFileSync(join(repoRoot, "node_modules", "package"), "ignored");
  const expectedCount = spawnSync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: repoRoot,
  }).stdout.toString("utf8").split("\0").filter(Boolean).length;
  return {
    base: realpathSync(base),
    repoRoot: realpathSync(repoRoot),
    quarantineRoot: realpathSync(quarantineRoot),
    branch: git(repoRoot, "symbolic-ref", "--short", "HEAD"),
    head: git(repoRoot, "rev-parse", "HEAD"),
    expectedCount,
    historyHead,
    canonicalPath,
    copyPath,
  };
}

export function invokeQuarantineWorker(
  operation: "exports" | "recover",
  request: Record<string, unknown>,
) {
  const source = `
import * as transaction from ${JSON.stringify(transactionUrl)};
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { operation, request } = JSON.parse(input);
try {
  const result = operation === "exports"
    ? { exports: Object.keys(transaction) }
    : await transaction.recoverQuarantine(request);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: {
    code: error?.code ?? null,
    message: error?.message,
  } }));
}
`;
  const worker = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    input: JSON.stringify({ operation, request }),
    encoding: "utf8",
  });
  if (worker.status !== 0) throw new Error(worker.stderr || "quarantine worker failed");
  return JSON.parse(worker.stdout) as {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string | null; message: string };
  };
}
