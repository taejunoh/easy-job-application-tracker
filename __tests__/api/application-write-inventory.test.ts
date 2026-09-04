import { readdir, readFile } from "node:fs/promises";
import { relative, join } from "node:path";

const inventory = [
  ["src/app/api/applications/route.ts", ["POST"]],
  ["src/app/api/applications/[id]/route.ts", ["PATCH", "DELETE"]],
  ["src/app/api/settings/route.ts", ["PUT"]],
  ["src/app/api/extension/pairing/route.ts", ["POST"]],
  ["src/app/api/extension/pair/route.ts", ["POST"]],
  ["src/app/api/extension/revoke/route.ts", ["POST"]],
  ["src/app/api/extension/installations/[id]/route.ts", ["DELETE"]],
] as const;

const persistencePattern = /\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert|createPairingGrant|exchangePairingCode|consumePairingGrant|revoke)\s*\(|\$executeRaw|\$transaction/u;

describe("application API write inventory", () => {
  it("contains exactly every route with a persistence operation", async () => {
    const routeFiles = await recursivelyReadRouteFiles(
      join(process.cwd(), "src/app/api"),
    );
    const persistenceFiles = routeFiles
      .filter(({ source }) => persistencePattern.test(source))
      .map(({ path }) => path)
      .sort();
    const inventoryFiles = inventory.map(([path]) => path).sort();

    expect(persistenceFiles).toEqual(inventoryFiles);
  });

  it("declares the exact protected write methods and route deadlines", async () => {
    const routeSources = await Promise.all(
      inventory.map(async ([path, methods]) => ({
        path,
        methods,
        source: await readFile(join(process.cwd(), path), "utf8"),
      })),
    );

    for (const { path, methods, source } of routeSources) {
      expect(source).toMatch(
        /export\s+const\s+maxDuration\s*=\s*30\s*;/u,
      );

      if (path === "src/app/api/extension/pair/route.ts") {
        expect(source).toMatch(/applicationWritesEnabled\s*\(\s*\)/u);
        expect(source).toMatch(/applicationWritesStoppedResponse\s*\(\s*\)/u);
        continue;
      }

      const declarations = [
        ...source.matchAll(/writeMethods\s*:\s*\[([^\]]*)\]/gu),
      ];
      expect(declarations).toHaveLength(1);
      const declaredMethods = [
        ...declarations[0][1].matchAll(/(["'])([A-Z]+)\1/gu),
      ].map((match) => match[2]);
      expect(declaredMethods).toEqual([...methods]);
    }
  });

  it("keeps authentication persistence closed-mode and declared-write touch suppression", async () => {
    const source = await readFile(
      join(process.cwd(), "src/lib/security/auth.ts"),
      "utf8",
    );

    expect(source).toMatch(
      /config\.applicationWritesEnabled\s*&&\s*options\.touchInstallation\s*!==\s*false/u,
    );
    const protectedRouteSource = await readFile(
      join(process.cwd(), "src/lib/security/protected-route.ts"),
      "utf8",
    );
    expect(protectedRouteSource).toMatch(
      /const\s+isWriteMethod\s*=\s*writeMethods\.has\(/u,
    );
    expect(protectedRouteSource).toMatch(
      /authenticateApiRequestAsync\(request,\s*\{\s*touchInstallation:\s*!isWriteMethod\s*,?\s*\}\s*\)\s*;/u,
    );
  });
});

async function recursivelyReadRouteFiles(
  directory: string,
): Promise<readonly { path: string; source: string }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; source: string }> = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await recursivelyReadRouteFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || entry.name !== "route.ts") continue;
    const path = relative(process.cwd(), entryPath).split("\\").join("/");
    files.push({ path, source: await readFile(entryPath, "utf8") });
  }

  return files;
}
