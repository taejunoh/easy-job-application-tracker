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

  it("pins the supported Anthropic, Prisma, Node type, and PostCSS releases", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@anthropic-ai/sdk": "0.111.0",
      "@prisma/adapter-pg": "7.8.0",
      "@prisma/client": "7.8.0",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@types/node": "22.20.1",
      postcss: "8.5.19",
      prisma: "7.8.0",
    });
  });

  it("locks each supported direct dependency to the declared version", () => {
    const rootPackage = packageLock.packages[""];
    const expected = {
      "@anthropic-ai/sdk": "0.111.0",
      "@prisma/adapter-pg": "7.8.0",
      "@prisma/client": "7.8.0",
      "@types/node": "22.20.1",
      postcss: "8.5.19",
      prisma: "7.8.0",
    } as const;

    for (const [name, version] of Object.entries(expected)) {
      const declared =
        rootPackage.dependencies?.[name] ?? rootPackage.devDependencies?.[name];
      expect(declared).toBe(version);
      expect(packageLock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });

  it("keeps Next on the supported 16.2.10 release", () => {
    expect(packageJson.dependencies.next).toBe("16.2.10");
    expect(packageLock.packages["node_modules/next"]?.version).toBe("16.2.10");
  });
});
