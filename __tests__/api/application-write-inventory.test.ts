import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as ts from "typescript";

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
const persistenceMarkers = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
  "createPairingGrant",
  "exchangePairingCode",
  "consumePairingGrant",
  "revoke",
  "$executeRaw",
  "$transaction",
]);

type RouteSource = Readonly<{
  path: string;
  source: string;
  file: ts.SourceFile;
}>;

describe("application API write inventory", () => {
  it("contains exactly every route with a persistence operation", async () => {
    const routeFiles = await recursivelyReadRouteFiles(
      join(process.cwd(), "src/app/api"),
    );
    const persistenceFiles = routeFiles
      .filter(({ source, file }) => {
        const structuralMatch = hasPersistenceCall(file);
        expect(persistencePattern.test(source)).toBe(structuralMatch);
        return structuralMatch;
      })
      .map(({ path }) => path)
      .sort();
    const inventoryFiles = inventory.map(([path]) => path).sort();

    expect(persistenceFiles).toEqual(inventoryFiles);
  });

  it("extracts exact protected writes and maxDuration from route ASTs", async () => {
    const routeSources = await Promise.all(
      inventory.map(async ([path, methods]) => {
        const source = await readFile(join(process.cwd(), path), "utf8");
        return {
          path,
          methods,
          source,
          file: ts.createSourceFile(
            path,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          ),
        };
      }),
    );

    for (const { path, methods, file } of routeSources) {
      expect(hasExportedMaxDuration(file)).toBe(true);

      if (path === "src/app/api/extension/pair/route.ts") {
        const postBody = exportedPostBody(file);
        expect(postBody).toBeDefined();
        expect(
          postBody && bodyCallsNamed(postBody, "applicationWritesEnabled"),
        ).toBe(true);
        expect(
          postBody && bodyCallsNamed(postBody, "applicationWritesStoppedResponse"),
        ).toBe(true);
        continue;
      }

      const protectedRouteCall = findProtectedRouteCall(file);
      expect(protectedRouteCall).toBeDefined();
      expect(
        protectedRouteCall &&
          extractProtectedWriteMethods(protectedRouteCall),
      ).toEqual([...methods]);
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
): Promise<readonly RouteSource[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: RouteSource[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await recursivelyReadRouteFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || entry.name !== "route.ts") continue;
    const source = await readFile(entryPath, "utf8");
    const path = relative(process.cwd(), entryPath).split("\\").join("/");
    files.push({
      path,
      source,
      file: ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    });
  }

  return files;
}

function hasPersistenceCall(file: ts.SourceFile): boolean {
  const aliases = new Set<string>();
  visit(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (ts.isIdentifier(node.name)) {
      if (markerFromExpression(node.initializer) !== undefined) {
        aliases.add(node.name.text);
      }
      return;
    }
    if (!ts.isObjectBindingPattern(node.name)) return;
    for (const element of node.name.elements) {
      const marker = element.propertyName
        ? markerFromName(element.propertyName)
        : markerFromName(element.name);
      if (marker !== undefined && ts.isIdentifier(element.name)) {
        aliases.add(element.name.text);
      }
    }
  });

  let found = false;
  visit(file, (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      found =
        markerFromExpression(node.expression) !== undefined ||
        (ts.isIdentifier(node.expression) && aliases.has(node.expression.text));
    } else if (ts.isTaggedTemplateExpression(node)) {
      found = markerFromExpression(node.tag) !== undefined;
    }
  });
  return found;
}

function findProtectedRouteCall(
  file: ts.SourceFile,
): ts.CallExpression | undefined {
  const calls: ts.CallExpression[] = [];
  visit(file, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createProtectedRoute"
    ) {
      calls.push(node);
    }
  });
  if (calls.length !== 1) return undefined;

  const call = calls[0];
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return undefined;
  }
  const routeName = declaration.name.text;
  let exportedUse = false;
  visit(file, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== routeName) {
      return;
    }
    let parent: ts.Node | undefined = node.parent;
    while (parent !== undefined && !ts.isSourceFile(parent)) {
      if (
        ts.isVariableStatement(parent) &&
        hasExportModifier(parent.modifiers)
      ) {
        exportedUse = true;
        return;
      }
      parent = parent.parent;
    }
  });
  return exportedUse ? call : undefined;
}

function extractProtectedWriteMethods(
  call: ts.CallExpression,
): readonly string[] | undefined {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const property = options.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === "writeMethods",
  );
  if (!property || !ts.isArrayLiteralExpression(property.initializer)) {
    return undefined;
  }
  const methods: string[] = [];
  for (const element of property.initializer.elements) {
    if (!ts.isStringLiteral(element)) return undefined;
    methods.push(element.text);
  }
  return methods;
}

function hasExportedMaxDuration(file: ts.SourceFile): boolean {
  let matches = 0;
  let valid = false;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement.modifiers)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "maxDuration"
      ) {
        matches += 1;
        valid =
          declaration.initializer !== undefined &&
          ts.isNumericLiteral(declaration.initializer) &&
          declaration.initializer.text === "30";
      }
    }
  }
  return matches === 1 && valid;
}

function exportedPostBody(file: ts.SourceFile): ts.Node | undefined {
  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "POST" &&
      hasExportModifier(statement.modifiers)
    ) {
      return statement.body;
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement.modifiers)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "POST" &&
        declaration.initializer
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function bodyCallsNamed(body: ts.Node, name: string): boolean {
  let found = false;
  visit(body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
    }
  });
  return found;
}

function markerFromExpression(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return markerFromName(node.name);
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return markerFromName(node.argumentExpression);
  }
  return ts.isIdentifier(node) ? markerFromName(node) : undefined;
}

function markerFromName(node: ts.PropertyName | ts.BindingName): string | undefined {
  const name = propertyName(node);
  return persistenceMarkers.has(name) ? name : undefined;
}

function propertyName(node: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return "";
}

function hasExportModifier(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): boolean {
  return modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
