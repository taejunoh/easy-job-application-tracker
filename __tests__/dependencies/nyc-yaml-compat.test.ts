import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const localRequire = createRequire(join(resolve(__dirname, "../.."), "package.json"));
const { loadNycConfig } = localRequire("@istanbuljs/load-nyc-config") as {
  loadNycConfig: (options: { cwd: string; nycrcPath: string }) => Promise<Record<string, unknown>>;
};
let fixture: string;
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "nyc-yaml-compat-")));
  writeFileSync(join(fixture, "package.json"), '{"private":true}');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

it.each(["yml", "yaml"])("loads real NYC .%s extends, arrays, booleans, paths and thresholds", async extension => {
  writeFileSync(join(fixture, "base.yaml"), "all: true\ncheck-coverage: true\nlines: 90\nbranches: 80\ncwd: ./coverage-root\nexclude: [fixtures/**, '**/*.test.ts']\n");
  writeFileSync(join(fixture, `.nycrc.${extension}`), "extends: ./base.yaml\ninclude: [src/**/*.ts, 'folder with space/**/*.tsx']\nrequire: ./register.cjs\nextension: [.ts, .tsx]\nreporter: [text, lcov]\nfunctions: 85\nstatements: 88\n");
  const config = await loadNycConfig({ cwd: fixture, nycrcPath: `.nycrc.${extension}` });
  expect(config).toMatchObject({ all: true, checkCoverage: true, cwd: join(fixture, "coverage-root"), lines: 90, branches: 80, functions: 85, statements: 88, include: ["src/**/*.ts", "folder with space/**/*.tsx"], exclude: ["fixtures/**", "**/*.test.ts"], require: ["./register.cjs"], extension: [".ts", ".tsx"], reporter: ["text", "lcov"] });
});

it("intentionally rejects unsafe JavaScript YAML tags through the real loader", async () => {
  writeFileSync(join(fixture, ".nycrc.yml"), 'require: !!js/function "function () { return 1; }"\n');
  await expect(loadNycConfig({ cwd: fixture, nycrcPath: ".nycrc.yml" })).rejects.toThrow(/unknown tag/);
});

it("documents YAML4 numeric semantics rather than claiming YAML3 parity", async () => {
  writeFileSync(join(fixture, ".nycrc.yaml"), 'lines: 012\nbranches: 0o12\nfunctions: 1:20\nstatements: "012"\n');
  const config = await loadNycConfig({ cwd: fixture, nycrcPath: ".nycrc.yaml" });
  expect(config).toMatchObject({ lines: 12, branches: 10, functions: "1:20", statements: "012" });
});
