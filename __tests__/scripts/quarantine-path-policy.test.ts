import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-path-policy.mjs"),
).href;

function invoke(operation: string, args: unknown[], seam?: "device-mismatch" | "exdev") {
  const source = `
import * as policy from ${JSON.stringify(moduleUrl)};
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let copyCalls = 0;
const fsApi = request.seam === "device-mismatch" ? {
  lstat: async (path) => ({ dev: path === request.args[1] ? 2 : 1, isSymbolicLink: () => false }),
  realpath: async (path) => path,
} : request.seam === "exdev" ? {
  lstat: async () => { const error = new Error("cross-device"); error.code = "EXDEV"; throw error; },
  realpath: async (path) => path,
  copyFile: async () => { copyCalls += 1; },
} : undefined;
try {
  const target = policy[request.operation];
  const value = request.operation === "GENERATED_ROOTS"
    ? policy.GENERATED_ROOTS
    : await target(...request.args, ...(fsApi ? [fsApi] : []));
  process.stdout.write(JSON.stringify({ ok: true, value, copyCalls }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { message: error.message, code: error.code },
    copyCalls,
  }));
}
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify({ operation, args, seam }),
    }),
  );
  if (!result.ok) {
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
      copyCalls: result.copyCalls,
    });
  }
  return result.value;
}

const canonicalPathForNumberedCopy = (value: string) =>
  invoke("canonicalPathForNumberedCopy", [value]);
const parseManifestEntry = (value: unknown) => invoke("parseManifestEntry", [value]);
const derivePayloadPath = (runRoot: string, entry: unknown) =>
  invoke("derivePayloadPath", [runRoot, entry]);
const assertPathUnderRoot = (root: string, value: string) =>
  invoke("assertPathUnderRoot", [root, value]);
const assertSameDevice = async (
  repoRoot: string,
  quarantineRoot: string,
  seam?: "device-mismatch" | "exdev",
) => invoke("assertSameDevice", [repoRoot, quarantineRoot], seam);

function sourceEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "copy-0001",
    kind: "source-copy",
    relativePath: "src/example 2.ts",
    canonicalRelativePath: "src/example.ts",
    ...overrides,
  };
}

function generatedEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "generated-node-modules",
    kind: "generated-root",
    relativePath: "node_modules",
    ...overrides,
  };
}

function tempResidueEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "temp-0001",
    kind: "temp-residue",
    relativePath: "src/.BC.T_aB09Zx",
    ...overrides,
  };
}

describe("quarantine path policy", () => {
  it("maps only a numbered suffix on the final component", () => {
    expect(canonicalPathForNumberedCopy("src/archive 2/example 23.test.ts")).toBe(
      "src/archive 2/example.test.ts",
    );
    expect(() => canonicalPathForNumberedCopy("src/example 1.ts")).toThrow(/numbered copy/u);
    expect(() => canonicalPathForNumberedCopy("src/example 2/no-suffix.ts")).toThrow(
      /numbered copy/u,
    );
  });

  it.each(["../victim", "/tmp/victim", "src/../victim", "src/\0victim", "src//victim"])(
    "rejects unsafe manifest paths: %s",
    (relativePath) => expect(() => parseManifestEntry(sourceEntry({ relativePath }))).toThrow(),
  );

  it("rejects backslashes and non-normalized Unicode paths", () => {
    expect(() => parseManifestEntry(sourceEntry({ relativePath: "src\\example 2.ts" }))).toThrow();
    expect(() =>
      parseManifestEntry(
        sourceEntry({
          relativePath: "src/Cafe\u0301 2.ts",
          canonicalRelativePath: "src/Cafe\u0301.ts",
        }),
      ),
    ).toThrow(/NFC/u);
  });

  it("requires plain objects with an exact closed schema", () => {
    expect(() => parseManifestEntry({ ...sourceEntry(), attackerPath: "../victim" })).toThrow(
      /unknown field/u,
    );
    expect(() => parseManifestEntry([])).toThrow(/plain object/u);
    expect(() => parseManifestEntry(sourceEntry({ canonicalRelativePath: undefined }))).toThrow();
  });

  it("requires the stored canonical source-copy path to equal the derived path", () => {
    expect(() =>
      parseManifestEntry(sourceEntry({ canonicalRelativePath: "src/attacker.ts" })),
    ).toThrow(/canonical/u);
    expect(() => parseManifestEntry(sourceEntry({ relativePath: "src/not-numbered.ts" }))).toThrow(
      /numbered copy/u,
    );
  });

  it("allows only the two fixed generated roots", () => {
    expect(invoke("GENERATED_ROOTS", [])).toEqual(["node_modules", ".next"]);
    expect(parseManifestEntry(generatedEntry()).relativePath).toBe("node_modules");
    expect(
      parseManifestEntry(
        generatedEntry({ id: "generated-next", relativePath: ".next" }),
      ).relativePath,
    ).toBe(".next");
    expect(() => parseManifestEntry(generatedEntry({ relativePath: "dist" }))).toThrow(
      /generated root/u,
    );
  });

  it("accepts only exact temporary-residue basenames with deterministic IDs", () => {
    expect(parseManifestEntry(tempResidueEntry())).toEqual(tempResidueEntry());
    for (const relativePath of [
      "src/.BC.T_aB09Z",
      "src/.BC.T_aB09Zx7",
      "src/.BC.T_aB-9Zx",
      "src/.bc.T_aB09Zx",
      "src/prefix.BC.T_aB09Zx",
      "src/.BC.T_Cafe\u0301",
    ]) {
      expect(() => parseManifestEntry(tempResidueEntry({ relativePath }))).toThrow();
    }
    expect(() => parseManifestEntry(tempResidueEntry({ id: "copy-0001" }))).toThrow(/ID/u);
    expect(() => parseManifestEntry({ ...tempResidueEntry(), canonicalRelativePath: "src/x" })).toThrow(
      /unknown field/u,
    );
  });

  it("derives destinations from validated IDs and the generated-root allowlist", () => {
    const runRoot = join(tmpdir(), "quarantine-run");
    const copy = parseManifestEntry(sourceEntry());
    const generated = parseManifestEntry(generatedEntry());

    expect(derivePayloadPath(runRoot, copy)).toBe(
      join(runRoot, "payload", "source-copies", "copy-0001"),
    );
    expect(derivePayloadPath(runRoot, generated)).toBe(
      join(runRoot, "payload", "generated", "node_modules"),
    );
    expect(derivePayloadPath(runRoot, tempResidueEntry())).toBe(
      join(runRoot, "payload", "temp-residues", "temp-0001"),
    );
    expect(() => parseManifestEntry(sourceEntry({ id: "../escape" }))).toThrow(/ID/u);
  });

  it("rejects traversal, symlink roots, and symlink ancestors while allowing a leaf symlink", () => {
    const base = mkdtempSync(join(tmpdir(), "quarantine-policy-"));
    const root = join(base, "repo");
    mkdirSync(join(root, "safe"), { recursive: true });
    writeFileSync(join(root, "safe", "file.txt"), "safe");

    expect(assertPathUnderRoot(root, "safe/file.txt")).toBe(
      join(realpathSync(root), "safe", "file.txt"),
    );
    expect(() => assertPathUnderRoot(root, "../victim")).toThrow();

    symlinkSync(join(root, "safe", "file.txt"), join(root, "leaf-link"));
    expect(assertPathUnderRoot(root, "leaf-link")).toBe(join(realpathSync(root), "leaf-link"));

    symlinkSync(dirname(root), join(root, "escape"));
    expect(() => assertPathUnderRoot(root, "escape/victim")).toThrow(/symlink/u);

    const rootLink = join(base, "repo-link");
    symlinkSync(root, rootLink);
    expect(() => assertPathUnderRoot(rootLink, "safe/file.txt")).toThrow(/symlink root/u);
  });

  it("requires an external quarantine root on the same device", async () => {
    const base = mkdtempSync(join(tmpdir(), "quarantine-device-"));
    const repo = join(base, "repo");
    const quarantine = join(base, "quarantine");
    mkdirSync(repo);
    mkdirSync(quarantine);
    mkdirSync(join(repo, "nested"));

    await expect(assertSameDevice(repo, quarantine)).resolves.toBeUndefined();
    await expect(assertSameDevice(repo, join(repo, "nested"))).rejects.toThrow(/outside/u);

    await expect(assertSameDevice(repo, quarantine, "device-mismatch")).rejects.toThrow(/device/u);
  });

  it("propagates EXDEV without attempting a fallback", async () => {
    await expect(assertSameDevice("/repo", "/quarantine", "exdev")).rejects.toMatchObject({
      code: "EXDEV",
      copyCalls: 0,
    });
  });
});
