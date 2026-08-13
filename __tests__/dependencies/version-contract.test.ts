import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

describe("supported direct dependency versions", () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const packageLock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      {
        version?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }
    >;
  };

  it("pins the supported Anthropic, Next, Prisma, Undici, Node type, and PostCSS releases", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@anthropic-ai/sdk": "0.111.0",
      "@next/env": "16.3.0",
      "@prisma/adapter-pg": "7.9.1",
      "@prisma/client": "7.9.1",
      next: "16.3.0",
      undici: "7.29.0",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@types/node": "22.20.1",
      "eslint-config-next": "16.3.0",
      postcss: "8.5.26",
      prisma: "7.9.1",
    });
  });

  it("locks each supported direct dependency to the declared version", () => {
    const rootPackage = packageLock.packages[""];
    const expected = {
      "@anthropic-ai/sdk": "0.111.0",
      "@next/env": "16.3.0",
      "@prisma/adapter-pg": "7.9.1",
      "@prisma/client": "7.9.1",
      "@types/node": "22.20.1",
      "eslint-config-next": "16.3.0",
      next: "16.3.0",
      postcss: "8.5.26",
      prisma: "7.9.1",
      undici: "7.29.0",
    } as const;

    for (const [name, version] of Object.entries(expected)) {
      const declared =
        rootPackage.dependencies?.[name] ?? rootPackage.devDependencies?.[name];
      expect(declared).toBe(version);
      expect(packageLock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });

  it("keeps Next and its lint config on the supported 16.3.0 release", () => {
    expect(packageJson.dependencies.next).toBe("16.3.0");
    expect(packageJson.devDependencies["eslint-config-next"]).toBe("16.3.0");
    expect(packageLock.packages["node_modules/next"]?.version).toBe("16.3.0");
    expect(packageLock.packages["node_modules/eslint-config-next"]?.version).toBe(
      "16.3.0",
    );
  });
});
