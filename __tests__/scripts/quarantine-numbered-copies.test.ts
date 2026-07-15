import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalPathForNumberedCopy,
  inspectWorkspace,
} from "../../scripts/quarantine-numbered-copies-support.mjs";

type TemporaryRepository = Readonly<{
  head: string;
  quarantineRoot: string;
  root: string;
  cleanup(): void;
}>;

describe("numbered-copy workspace inventory", () => {
  it.each([
    ["src/lib/server-env 2.ts", "src/lib/server-env.ts"],
    [
      "scripts/verify-invalid-startup 3.mjs",
      "scripts/verify-invalid-startup.mjs",
    ],
  ])("maps the final numbered filename in %s", (input, expected) => {
    expect(canonicalPathForNumberedCopy(input)).toBe(expected);
  });

  it.each(["src/lib/version2.ts", "src/lib 2/server-env.ts"])(
    "rejects a non-copy path %s",
    (input) => {
      expect(canonicalPathForNumberedCopy(input)).toBeNull();
    },
  );

  it("classifies a synthetic repository without serializing divergent bodies", async () => {
    const fixture = createRepository();
    try {
      writeFixture(fixture.root, "src/identical.ts", "same\n");
      writeFixture(fixture.root, "src/divergent.ts", "canonical\n");
      commitAll(fixture.root, "add canonical files");
      writeFixture(fixture.root, "src/identical 2.ts", "same\n");
      writeFixture(
        fixture.root,
        "src/divergent 2.ts",
        "divergent-private-body\n",
      );

      const inspection = await inspectWorkspace(
        {
          repositoryRoot: fixture.root,
          quarantineRoot: fixture.quarantineRoot,
          expectedBranch: "main",
          expectedHead: git(fixture.root, ["rev-parse", "HEAD"]),
          expectedCount: 2,
          now: new Date("2026-07-14T12:00:00.000Z"),
        },
        {
          statfs: async () => ({ bavail: 1_000_000, bsize: 4_096 }),
        },
      );

      expect(inspection.copies).toHaveLength(2);
      expect(
        inspection.copies.map((copy) => [
          copy.originalPath,
          copy.canonicalPath,
          copy.classification,
        ]),
      ).toEqual([
        ["src/divergent 2.ts", "src/divergent.ts", "divergent"],
        ["src/identical 2.ts", "src/identical.ts", "identical"],
      ]);
      expect(JSON.stringify(inspection)).not.toContain(
        "divergent-private-body",
      );
    } finally {
      fixture.cleanup();
    }
  });
});

function createRepository(): TemporaryRepository {
  const root = mkdtempSync(join(tmpdir(), "jobtracker-quarantine-repo-"));
  const quarantineRoot = mkdtempSync(
    join(tmpdir(), "jobtracker-quarantine-output-"),
  );
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "quarantine-test@example.test"]);
  git(root, ["config", "user.name", "Quarantine Test"]);
  writeFixture(root, ".gitignore", "node_modules/\n.next/\n");
  commitAll(root, "initialize fixture");

  return {
    root,
    quarantineRoot,
    head: git(root, ["rev-parse", "HEAD"]),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(quarantineRoot, { recursive: true, force: true });
    },
  };
}

function writeFixture(root: string, relativePath: string, contents: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function commitAll(root: string, message: string) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--message", message]);
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
