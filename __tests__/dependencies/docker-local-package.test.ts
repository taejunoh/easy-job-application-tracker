import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(__dirname, "../..");

describe("Docker dependency installation inputs", () => {
  it("copies every local package artifact before npm ci without broadening the install-stage context", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const localPackages = Object.values({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter((version): version is string => version.startsWith("file:"))
      .map(version => version.slice("file:".length));
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    const dependenciesStage = dockerfile.split(/^FROM /m)[1];
    expect(dependenciesStage).toBeDefined();
    const firstInstallIndex = dependenciesStage!.indexOf("RUN npm ci");
    expect(firstInstallIndex).toBeGreaterThanOrEqual(0);
    const installInputs = dependenciesStage!.slice(0, firstInstallIndex);

    for (const localPackage of localPackages) {
      const artifact = resolve(root, localPackage);
      expect(existsSync(artifact)).toBe(true);
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", localPackage], { cwd: root, encoding: "utf8" });
      expect(tracked.status).toBe(0);
      expect(installInputs.split(/\r?\n/).some(line => line.trim() === `COPY ${localPackage} ${localPackage}`)).toBe(true);
    }

    expect(installInputs).not.toMatch(/^COPY(?:\s+--[^\s]+)*\s+\.\s/m);
  });
});
