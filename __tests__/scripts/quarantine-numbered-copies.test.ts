import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const supportModule = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-numbered-copies-support.mjs"),
).href;

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
    expect(invokeSupport("canonicalPathForNumberedCopy", [input])).toBe(
      expected,
    );
  });

  it.each(["src/lib/version2.ts", "src/lib 2/server-env.ts"])(
    "rejects a non-copy path %s",
    (input) => {
      expect(invokeSupport("canonicalPathForNumberedCopy", [input])).toBeNull();
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

      const inspection = invokeSupport<WorkspaceInspection>(
        "inspectWorkspace",
        [
          {
            repositoryRoot: fixture.root,
            quarantineRoot: fixture.quarantineRoot,
            expectedBranch: "main",
            expectedHead: git(fixture.root, ["rev-parse", "HEAD"]),
            expectedCount: 2,
            now: new Date("2026-07-14T12:00:00.000Z"),
          },
        ],
        { availableBytes: 4_096_000_000 },
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

  it("searches every ref for a divergent copy's historical canonical contents", () => {
    const fixture = createRepository();
    try {
      writeFixture(fixture.root, "src/canonical.ts", "main-version\n");
      commitAll(fixture.root, "add canonical on main");
      git(fixture.root, ["checkout", "-b", "archived-copy"]);
      writeFixture(fixture.root, "src/canonical.ts", "archived-version\n");
      commitAll(fixture.root, "archive matching version");
      const archivedHead = git(fixture.root, ["rev-parse", "HEAD"]);
      git(fixture.root, ["checkout", "main"]);
      writeFixture(fixture.root, "src/canonical 2.ts", "archived-version\n");

      const inspection = invokeSupport<WorkspaceInspection>(
        "inspectWorkspace",
        [approvedOptions(fixture, 1)],
        { availableBytes: 4_096_000_000 },
      );

      expect(inspection.copies[0].historyMatch).toBe(archivedHead);
    } finally {
      fixture.cleanup();
    }
  });

  it("requires available space to be strictly greater than the archive size", () => {
    const fixture = createPopulatedRepository();
    try {
      const requiredBytes =
        statSync(join(fixture.root, "src/identical 2.ts")).size +
        statSync(join(fixture.root, "src/divergent 3.ts")).size +
        apparentFixtureSize(join(fixture.root, "node_modules")) +
        apparentFixtureSize(join(fixture.root, ".next"));

      expect(() =>
        invokeSupport("inspectWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: requiredBytes,
        }),
      ).toThrow();
      expect(() =>
        invokeSupport("inspectWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: requiredBytes + 1,
        }),
      ).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects every unapproved workspace or storage precondition", () => {
    const cases: Array<{
      name: string;
      prepare(fixture: TemporaryRepository): Record<string, unknown>;
      seams?: Readonly<{ availableBytes?: number }>;
    }> = [
      {
        name: "branch",
        prepare: () => ({ expectedBranch: "other" }),
      },
      {
        name: "head",
        prepare: () => ({ expectedHead: "0".repeat(40) }),
      },
      {
        name: "count",
        prepare: () => ({ expectedCount: 2 }),
      },
      {
        name: "tracked",
        prepare: (fixture) => {
          writeFixture(fixture.root, "canonical.ts", "changed\n");
          return {};
        },
      },
      {
        name: "staged",
        prepare: (fixture) => {
          writeFixture(fixture.root, "canonical.ts", "staged\n");
          git(fixture.root, ["add", "canonical.ts"]);
          return {};
        },
      },
      {
        name: "internal quarantine",
        prepare: (fixture) => {
          const internal = join(fixture.root, "internal-quarantine");
          mkdirSync(internal);
          return { quarantineRoot: internal };
        },
      },
      {
        name: "space",
        prepare: () => ({}),
        seams: { availableBytes: 0 },
      },
    ];

    for (const testCase of cases) {
      const fixture = createRepository();
      try {
        writeFixture(fixture.root, "canonical.ts", "canonical\n");
        commitAll(fixture.root, "add canonical");
        writeFixture(fixture.root, "canonical 2.ts", "copy\n");
        const overrides = testCase.prepare(fixture);
        expect(() =>
          invokeSupport(
            "inspectWorkspace",
            [{ ...approvedOptions(fixture, 1), ...overrides }],
            testCase.seams ?? { availableBytes: 4_096_000_000 },
          ),
        ).toThrow();
      } finally {
        fixture.cleanup();
      }
    }
  });
});

describe("verified workspace quarantine transaction", () => {
  it("copies, verifies, and removes source copies and complete generated trees", () => {
    const fixture = createPopulatedRepository();
    try {
      const result = invokeSupport<QuarantineResult>(
        "quarantineWorkspace",
        [approvedOptions(fixture, 2)],
        { availableBytes: 4_096_000_000 },
      );
      const manifest = readManifest(result.runDirectory);
      const manifestDirectory = currentGenerationDirectory(result.runDirectory);

      expect(manifest.state).toBe("quarantined");
      expect(statSync(result.runDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(join(result.runDirectory, "current")).mode & 0o777).toBe(
        0o600,
      );
      expect(
        statSync(join(manifestDirectory, "manifest.json")).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(join(manifestDirectory, "manifest.sha256")).mode & 0o777,
      ).toBe(0o600);
      expectManifestChecksum(result.runDirectory);

      for (const relativePath of [
        "src/identical 2.ts",
        "src/divergent 3.ts",
        "node_modules",
        ".next",
      ]) {
        expect(existsSync(join(fixture.root, relativePath))).toBe(false);
      }
      expect(
        readFileSync(
          join(result.runDirectory, "source-copies/src/identical 2.ts"),
          "utf8",
        ),
      ).toBe("same\n");
      expect(
        statSync(join(result.runDirectory, "source-copies/src/identical 2.ts"))
          .mode & 0o777,
      ).toBe(0o640);
      expect(
        readlinkSync(
          join(result.runDirectory, "generated/node_modules/.bin/tool"),
        ),
      ).toBe("../tool.js");
      expect(manifest.generatedTrees.map((tree) => tree.path)).toEqual([
        ".next",
        "node_modules",
      ]);
      expect(findDeletionStagingPaths(fixture.root)).toEqual([]);

      const divergent = manifest.copies.find(
        (copy) => copy.classification === "divergent",
      );
      expect(divergent?.diffPath).toEqual(expect.any(String));
      const diffPath = join(result.runDirectory, divergent!.diffPath!);
      expect(statSync(diffPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(diffPath, "utf8")).toContain(
        "divergent-private-body",
      );
      expect(JSON.stringify(manifest)).not.toContain("divergent-private-body");
    } finally {
      fixture.cleanup();
    }
  });

  it("ignores an interrupted unpointed manifest generation", () => {
    const fixture = createPopulatedRepository();
    try {
      const quarantined = invokeSupport<QuarantineResult>(
        "quarantineWorkspace",
        [approvedOptions(fixture, 2)],
        { availableBytes: 4_096_000_000 },
      );
      expect(
        readFileSync(join(quarantined.runDirectory, "current"), "utf8"),
      ).toMatch(/^gen-[0-9]{6}\n$/u);
      const interruptedGeneration = join(
        quarantined.runDirectory,
        "manifest-generations/gen-000000",
      );
      mkdirSync(interruptedGeneration, { recursive: true });
      writeFileSync(join(interruptedGeneration, "manifest.json"), "{}\n");
      writeFileSync(
        join(interruptedGeneration, "manifest.sha256"),
        `${"0".repeat(64)}  manifest.json\n`,
      );

      writeFixture(fixture.root, "node_modules/package.json", "{}\n");
      writeFixture(fixture.root, ".next/build.txt", "fresh\n");
      const validated = invokeSupport<QuarantineManifest>(
        "markQuarantineValidated",
        [
          {
            repositoryRoot: fixture.root,
            runDirectory: quarantined.runDirectory,
            now: "2026-07-15T08:30:00.000Z",
          },
        ],
      );

      expect(validated.state).toBe("validated");
    } finally {
      fixture.cleanup();
    }
  });

  it("removes nothing when a live source changes after archive verification", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          mutateBeforeRemoval: {
            path: "src/identical 2.ts",
            contents: "newer-live-bytes\n",
          },
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      expect(readManifest(runDirectory).state).toBe("incomplete");
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("newer-live-bytes\n");
      for (const relativePath of [
        "src/divergent 3.ts",
        "node_modules/package.json",
        ".next/build.txt",
      ]) {
        expect(existsSync(join(fixture.root, relativePath))).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("restores an earlier removal without overwriting a later concurrent mutation", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          mutateBeforeRecheck: {
            path: "src/identical 2.ts",
            contents: "concurrent-newer-bytes\n",
          },
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      expect(readManifest(runDirectory).state).toBe("incomplete");
      expect(
        readFileSync(join(fixture.root, "src/divergent 3.ts"), "utf8"),
      ).toBe("divergent-private-body\n");
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("concurrent-newer-bytes\n");
      expect(
        statSync(join(fixture.root, "src/identical 2.ts")).mode & 0o777,
      ).toBe(0o640);
      expect(existsSync(join(fixture.root, "node_modules/package.json"))).toBe(
        true,
      );
      expect(existsSync(join(fixture.root, ".next/build.txt"))).toBe(true);
      expectManifestChecksum(runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a source copy recreated after staging without overwriting it", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          recreateAfterStaging: {
            relativePath: "src/identical 2.ts",
            contents: "newer-recreated-source\n",
          },
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      const manifest = readManifest(runDirectory);
      expect(manifest.state).toBe("incomplete");
      expect(manifest.concurrentRecreatedPaths).toEqual(["src/identical 2.ts"]);
      expect(manifest.deletionStagingResidues).toEqual([]);
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("newer-recreated-source\n");
      expect(
        readFileSync(join(fixture.root, "src/divergent 3.ts"), "utf8"),
      ).toBe("divergent-private-body\n");
      expect(
        readFileSync(join(fixture.root, "node_modules/package.json"), "utf8"),
      ).toBe("old\n");
      expect(readFileSync(join(fixture.root, ".next/build.txt"), "utf8")).toBe(
        "old-build\n",
      );
      expect(findDeletionStagingPaths(fixture.root)).toEqual([]);
      expect(JSON.stringify(manifest)).not.toContain("newer-recreated-source");
      expectManifestChecksum(runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a generated root recreated after staging without overwriting it", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          recreateAfterStaging: {
            relativePath: "node_modules",
            childPath: "concurrent-package.json",
            contents: "newer-generated-tree\n",
          },
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      const manifest = readManifest(runDirectory);
      expect(manifest.state).toBe("incomplete");
      expect(manifest.concurrentRecreatedPaths).toEqual(["node_modules"]);
      expect(manifest.deletionStagingResidues).toEqual([]);
      expect(
        readFileSync(
          join(fixture.root, "node_modules/concurrent-package.json"),
          "utf8",
        ),
      ).toBe("newer-generated-tree\n");
      expect(existsSync(join(fixture.root, "node_modules/package.json"))).toBe(
        false,
      );
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("same\n");
      expect(
        readFileSync(join(fixture.root, "src/divergent 3.ts"), "utf8"),
      ).toBe("divergent-private-body\n");
      expect(readFileSync(join(fixture.root, ".next/build.txt"), "utf8")).toBe(
        "old-build\n",
      );
      expect(findDeletionStagingPaths(fixture.root)).toEqual([]);
      expect(JSON.stringify(manifest)).not.toContain("newer-generated-tree");
      expectManifestChecksum(runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("restores every removed original when a later removal fails", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          failBeforeRemoval: ".next",
          onlyFailIfMissing: "node_modules",
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      expect(readManifest(runDirectory).state).toBe("incomplete");
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("same\n");
      expect(
        statSync(join(fixture.root, "src/identical 2.ts")).mode & 0o777,
      ).toBe(0o640);
      expect(
        readFileSync(join(fixture.root, "src/divergent 3.ts"), "utf8"),
      ).toBe("divergent-private-body\n");
      expect(
        readFileSync(join(fixture.root, "node_modules/package.json"), "utf8"),
      ).toBe("old\n");
      expect(readlinkSync(join(fixture.root, "node_modules/.bin/tool"))).toBe(
        "../tool.js",
      );
      expect(readFileSync(join(fixture.root, ".next/build.txt"), "utf8")).toBe(
        "old-build\n",
      );
      expectManifestChecksum(runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves concurrent originals and records residue after staged tree deletion fails", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          failStagedRemovalFor: "node_modules",
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      const manifest = readManifest(runDirectory);
      expect(manifest.state).toBe("incomplete");
      expect(manifest.concurrentRecreatedPaths).toEqual(["node_modules"]);
      expect(manifest.deletionStagingResidues).toHaveLength(1);
      const residuePath = join(
        fixture.root,
        manifest.deletionStagingResidues![0],
      );
      expect(existsSync(residuePath)).toBe(true);
      expect(
        readFileSync(
          join(residuePath, "node_modules/concurrent-residue.txt"),
          "utf8",
        ),
      ).toBe("staging-residue\n");

      expect(
        readFileSync(join(fixture.root, "node_modules/concurrent.txt"), "utf8"),
      ).toBe("newer-concurrent-tree\n");
      expect(existsSync(join(fixture.root, "node_modules/package.json"))).toBe(
        false,
      );
      expect(
        readFileSync(
          join(runDirectory, "generated/node_modules/package.json"),
          "utf8",
        ),
      ).toBe("old\n");
      expect(
        readlinkSync(join(runDirectory, "generated/node_modules/.bin/tool")),
      ).toBe("../tool.js");

      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("same\n");
      expect(
        statSync(join(fixture.root, "src/identical 2.ts")).mode & 0o777,
      ).toBe(0o640);
      expect(
        readFileSync(join(fixture.root, "src/divergent 3.ts"), "utf8"),
      ).toBe("divergent-private-body\n");
      expect(readFileSync(join(fixture.root, ".next/build.txt"), "utf8")).toBe(
        "old-build\n",
      );
      expect(JSON.stringify(manifest)).not.toContain("newer-concurrent-tree");
      expect(JSON.stringify(manifest)).not.toContain("staging-residue");
      expectManifestChecksum(runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("marks an incomplete manifest and leaves every original when archive verification fails", () => {
    const fixture = createPopulatedRepository();
    try {
      expect(() =>
        invokeSupport("quarantineWorkspace", [approvedOptions(fixture, 2)], {
          availableBytes: 4_096_000_000,
          corruptAfterCopy: "source-copies/src/identical 2.ts",
        }),
      ).toThrow();

      const runDirectory = onlyRunDirectory(fixture.quarantineRoot);
      expect(readManifest(runDirectory).state).toBe("incomplete");
      expectManifestChecksum(runDirectory);
      for (const relativePath of [
        "src/identical 2.ts",
        "src/divergent 3.ts",
        "node_modules/package.json",
        ".next/build.txt",
      ]) {
        expect(existsSync(join(fixture.root, relativePath))).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("requires clean regenerated trees before validation and sets the four-day deadline", () => {
    const fixture = createPopulatedRepository();
    try {
      const quarantined = invokeSupport<QuarantineResult>(
        "quarantineWorkspace",
        [approvedOptions(fixture, 2)],
        { availableBytes: 4_096_000_000 },
      );
      expect(() =>
        invokeSupport("markQuarantineValidated", [
          {
            repositoryRoot: fixture.root,
            runDirectory: quarantined.runDirectory,
            now: "2026-07-15T08:30:00.000Z",
          },
        ]),
      ).toThrow();

      writeFixture(fixture.root, "node_modules/package.json", "{}\n");
      writeFixture(fixture.root, ".next/build.txt", "fresh\n");
      const validated = invokeSupport<QuarantineManifest>(
        "markQuarantineValidated",
        [
          {
            repositoryRoot: fixture.root,
            runDirectory: quarantined.runDirectory,
            now: "2026-07-15T08:30:00.000Z",
          },
        ],
      );

      expect(validated.state).toBe("validated");
      expect(validated.validationAt).toBe("2026-07-15T08:30:00.000Z");
      expect(validated.retentionDays).toBe(4);
      expect(validated.deleteAfter).toBe("2026-07-19T08:30:00.000Z");
      expect(validated.deletionRequiresConfirmation).toBe(true);
      expectManifestChecksum(quarantined.runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("archives regenerated trees before restoring original paths and modes", () => {
    const fixture = createPopulatedRepository();
    try {
      const quarantined = invokeSupport<QuarantineResult>(
        "quarantineWorkspace",
        [approvedOptions(fixture, 2)],
        { availableBytes: 4_096_000_000 },
      );
      writeFixture(fixture.root, "node_modules/new-package.json", "fresh\n");
      writeFixture(fixture.root, ".next/new-build.txt", "fresh\n");

      const restored = invokeSupport<QuarantineManifest>("restoreQuarantine", [
        {
          repositoryRoot: fixture.root,
          runDirectory: quarantined.runDirectory,
          now: "2026-07-16T09:00:00.000Z",
        },
      ]);

      expect(restored.state).toBe("restored");
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("same\n");
      expect(
        statSync(join(fixture.root, "src/identical 2.ts")).mode & 0o777,
      ).toBe(0o640);
      expect(
        readFileSync(join(fixture.root, "node_modules/package.json"), "utf8"),
      ).toBe("old\n");
      expect(
        readFileSync(
          join(
            quarantined.runDirectory,
            "rollback/regenerated-before-restore/20260716T090000000Z/node_modules/new-package.json",
          ),
          "utf8",
        ),
      ).toBe("fresh\n");
      expectManifestChecksum(quarantined.runDirectory);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a corrupted manifest checksum without changing active or archived files", () => {
    const fixture = createPopulatedRepository();
    try {
      const quarantined = invokeSupport<QuarantineResult>(
        "quarantineWorkspace",
        [approvedOptions(fixture, 2)],
        { availableBytes: 4_096_000_000 },
      );
      writeFixture(fixture.root, "node_modules/new-package.json", "fresh\n");
      writeFileSync(
        join(
          currentGenerationDirectory(quarantined.runDirectory),
          "manifest.json",
        ),
        "{}\n",
      );

      expect(() =>
        invokeSupport("restoreQuarantine", [
          {
            repositoryRoot: fixture.root,
            runDirectory: quarantined.runDirectory,
            now: "2026-07-16T09:00:00.000Z",
          },
        ]),
      ).toThrow();
      expect(
        existsSync(join(fixture.root, "node_modules/new-package.json")),
      ).toBe(true);
      expect(
        existsSync(
          join(quarantined.runDirectory, "source-copies/src/identical 2.ts"),
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses restore conflicts before moving regenerated trees", () => {
    const fixture = createPopulatedRepository();
    try {
      const quarantined = invokeSupport<QuarantineResult>(
        "quarantineWorkspace",
        [approvedOptions(fixture, 2)],
        { availableBytes: 4_096_000_000 },
      );
      writeFixture(fixture.root, "node_modules/new-package.json", "fresh\n");
      writeFixture(fixture.root, "src/identical 2.ts", "conflict\n");

      expect(() =>
        invokeSupport("restoreQuarantine", [
          {
            repositoryRoot: fixture.root,
            runDirectory: quarantined.runDirectory,
            now: "2026-07-16T09:00:00.000Z",
          },
        ]),
      ).toThrow();
      expect(
        readFileSync(join(fixture.root, "src/identical 2.ts"), "utf8"),
      ).toBe("conflict\n");
      expect(
        existsSync(join(fixture.root, "node_modules/new-package.json")),
      ).toBe(true);
      expect(
        existsSync(
          join(quarantined.runDirectory, "source-copies/src/identical 2.ts"),
        ),
      ).toBe(true);
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

type WorkspaceInspection = Readonly<{
  copies: ReadonlyArray<{
    originalPath: string;
    canonicalPath: string;
    classification: "identical" | "divergent";
    historyMatch: string | null;
  }>;
}>;

type QuarantineResult = Readonly<{
  runDirectory: string;
}>;

type QuarantineManifest = Readonly<{
  concurrentRecreatedPaths?: ReadonlyArray<string>;
  deletionStagingResidues?: ReadonlyArray<string>;
  state: string;
  validationAt: string | null;
  retentionDays?: number;
  deleteAfter: string | null;
  deletionRequiresConfirmation: boolean;
  generatedTrees: ReadonlyArray<{ path: string }>;
  copies: ReadonlyArray<{
    classification: "identical" | "divergent";
    diffPath?: string | null;
  }>;
}>;

function invokeSupport<T>(
  operation: string,
  args: readonly unknown[],
  seams: Readonly<{
    availableBytes?: number;
    corruptAfterCopy?: string;
    failBeforeRemoval?: string;
    failStagedRemovalFor?: string;
    mutateBeforeRemoval?: Readonly<{ path: string; contents: string }>;
    mutateBeforeRecheck?: Readonly<{ path: string; contents: string }>;
    onlyFailIfMissing?: string;
    recreateAfterStaging?: Readonly<{
      childPath?: string;
      contents: string;
      relativePath: string;
    }>;
  }> = {},
): T {
  const source = `
import * as support from ${JSON.stringify(supportModule)};
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
try {
  const dependencies = {
    ...(request.seams.availableBytes === undefined ? {} : {
      statfs: async () => ({ bavail: request.seams.availableBytes, bsize: 1 }),
    }),
    ...(request.seams.corruptAfterCopy === undefined ? {} : {
      afterArchiveCopied: async ({ runDirectory }) => {
        await writeFile(
          join(runDirectory, request.seams.corruptAfterCopy),
          "corrupted-after-copy",
        );
      },
    }),
    ...(request.seams.mutateBeforeRemoval === undefined ? {} : {
      beforeDeletionPreflight: async ({ repositoryRoot }) => {
        await writeFile(
          join(repositoryRoot, request.seams.mutateBeforeRemoval.path),
          request.seams.mutateBeforeRemoval.contents,
        );
      },
    }),
    ...(request.seams.failBeforeRemoval === undefined ? {} : {
      beforeOriginalRemoval: async ({ relativePath, repositoryRoot }) => {
        if (relativePath !== request.seams.failBeforeRemoval) return;
        if (request.seams.onlyFailIfMissing !== undefined) {
          try {
            await lstat(join(repositoryRoot, request.seams.onlyFailIfMissing));
            return;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        throw new Error("Injected original-removal failure");
      },
    }),
    ...(request.seams.mutateBeforeRecheck === undefined ? {} : {
      beforeOriginalRemoval: async ({ relativePath, repositoryRoot }) => {
        if (relativePath !== request.seams.mutateBeforeRecheck.path) return;
        await writeFile(
          join(repositoryRoot, request.seams.mutateBeforeRecheck.path),
          request.seams.mutateBeforeRecheck.contents,
        );
      },
    }),
    ...(request.seams.failStagedRemovalFor === undefined ? {} : {
      afterOriginalStaged: async ({ relativePath, repositoryRoot }) => {
        if (relativePath !== request.seams.failStagedRemovalFor) return;
        const recreatedOriginal = join(repositoryRoot, relativePath);
        await mkdir(recreatedOriginal, { recursive: true });
        await writeFile(
          join(recreatedOriginal, "concurrent.txt"),
          "newer-concurrent-tree\\n",
        );
      },
      beforeStagingDirectoryRemoval: async ({
        relativePath,
        path,
        stagingPath,
      }) => {
        if (
          relativePath !== request.seams.failStagedRemovalFor ||
          path !== stagingPath
        ) return;
        await writeFile(join(path, "concurrent-residue.txt"), "staging-residue\\n");
      },
    }),
    ...(request.seams.recreateAfterStaging === undefined ? {} : {
      afterOriginalStaged: async ({ relativePath, repositoryRoot }) => {
        if (relativePath !== request.seams.recreateAfterStaging.relativePath) return;
        const originalPath = join(repositoryRoot, relativePath);
        const destination = request.seams.recreateAfterStaging.childPath === undefined
          ? originalPath
          : join(originalPath, request.seams.recreateAfterStaging.childPath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, request.seams.recreateAfterStaging.contents);
      },
    }),
  };
  const value = await support[request.operation](...request.args, dependencies);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "Unknown support failure",
  }));
}
`;
  const runnerRoot = mkdtempSync(
    join(tmpdir(), "jobtracker-quarantine-runner-"),
  );
  const runnerPath = join(runnerRoot, "invoke-support.mjs");
  writeFileSync(runnerPath, source);
  try {
    const output = execFileSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      input: JSON.stringify({ operation, args, seams }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const response = JSON.parse(output) as
      { ok: true; value: T } | { ok: false; error: string };
    if (!response.ok) throw new Error(response.error);
    return response.value;
  } finally {
    rmSync(runnerRoot, { recursive: true, force: true });
  }
}

function approvedOptions(fixture: TemporaryRepository, expectedCount: number) {
  return {
    repositoryRoot: fixture.root,
    quarantineRoot: fixture.quarantineRoot,
    expectedBranch: "main",
    expectedHead: git(fixture.root, ["rev-parse", "HEAD"]),
    expectedCount,
    now: "2026-07-14T12:00:00.000Z",
  };
}

function createPopulatedRepository(): TemporaryRepository {
  const fixture = createRepository();
  writeFixture(fixture.root, "src/identical.ts", "same\n");
  writeFixture(fixture.root, "src/divergent.ts", "canonical\n");
  commitAll(fixture.root, "add canonical sources");
  writeFixture(fixture.root, "src/identical 2.ts", "same\n");
  chmodSync(join(fixture.root, "src/identical 2.ts"), 0o640);
  writeFixture(fixture.root, "src/divergent 3.ts", "divergent-private-body\n");
  writeFixture(fixture.root, "node_modules/package.json", "old\n");
  writeFixture(fixture.root, "node_modules/tool.js", "tool\n");
  mkdirSync(join(fixture.root, "node_modules/.bin"), { recursive: true });
  symlinkSync("../tool.js", join(fixture.root, "node_modules/.bin/tool"));
  writeFixture(fixture.root, ".next/build.txt", "old-build\n");
  return fixture;
}

function onlyRunDirectory(quarantineRoot: string): string {
  const entries = readdirSync(quarantineRoot);
  expect(entries).toHaveLength(1);
  return join(quarantineRoot, entries[0]);
}

function readManifest(runDirectory: string): QuarantineManifest {
  return JSON.parse(
    readFileSync(
      join(currentGenerationDirectory(runDirectory), "manifest.json"),
      "utf8",
    ),
  ) as QuarantineManifest;
}

function expectManifestChecksum(runDirectory: string) {
  const generationDirectory = currentGenerationDirectory(runDirectory);
  const contents = readFileSync(join(generationDirectory, "manifest.json"));
  const expected = createHash("sha256").update(contents).digest("hex");
  const checksum = readFileSync(
    join(generationDirectory, "manifest.sha256"),
    "utf8",
  ).trim();
  expect(checksum).toBe(`${expected}  manifest.json`);
}

function currentGenerationDirectory(runDirectory: string): string {
  const generation = readFileSync(join(runDirectory, "current"), "utf8").trim();
  expect(generation).toMatch(/^gen-[0-9]{6}$/u);
  return join(runDirectory, "manifest-generations", generation);
}

function writeFixture(root: string, relativePath: string, contents: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function apparentFixtureSize(path: string): number {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  return (
    stats.size +
    readdirSync(path).reduce(
      (total, name) => total + apparentFixtureSize(join(path, name)),
      0,
    )
  );
}

function findDeletionStagingPaths(path: string): string[] {
  const matches: string[] = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (name.startsWith(".quarantine-delete-")) {
      matches.push(child);
      continue;
    }
    if (lstatSync(child).isDirectory()) {
      matches.push(...findDeletionStagingPaths(child));
    }
  }
  return matches.sort();
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
