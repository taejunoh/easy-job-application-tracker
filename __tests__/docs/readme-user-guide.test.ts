import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

const setupImages = [
  "06-chrome-load-unpacked.png",
  "07-extension-connect.png",
  "08-extension-connected.png",
];

const setupImageDimensions = new Map([
  ["06-chrome-load-unpacked.png", { width: 1280, height: 720 }],
  ["07-extension-connect.png", { width: 320, height: 210 }],
  ["08-extension-connected.png", { width: 320, height: 210 }],
]);

const setupCaptureFunctions = [
  "captureChromeLoadUnpacked",
  "captureExtensionConnect",
  "captureExtensionConnected",
];

const documentedPlaceholderTokens = new Set([
  "<second-generated-secret>",
  "<access-token>",
  "REPLACE_WITH_GENERATED_TOKEN",
  "YOUR_ACCESS_TOKEN",
  "TEST_ONLY_ACCESS_TOKEN",
  "ci-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]);

function isAllowedDocumentedTokenLiteral(value: string) {
  return (
    value.length === 0 ||
    documentedPlaceholderTokens.has(value) ||
    /^<[a-z0-9]+(?:-[a-z0-9]+)*>$/iu.test(value) ||
    /^(?:test-only|test_only)(?:[-_][a-z0-9]+)*[-_]token(?:[-_][a-z0-9]+)*$/iu.test(
      value,
    )
  );
}

function isSafeDocumentedTokenExpression(expression: string) {
  const normalizedExpression = expression.trim();

  if (normalizedExpression.length === 0) {
    return true;
  }

  const literal = normalizedExpression.match(
    /^(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s`#;$()\r\n]+))$/u,
  );
  const literalValue =
    literal?.[1] ?? literal?.[2] ?? literal?.[3];

  return (
    literalValue !== undefined &&
    isAllowedDocumentedTokenLiteral(literalValue)
  );
}

function readDocumentedTokenAssignments(markdown: string) {
  return markdown.split(/\r?\n/u).flatMap((line) => {
    const assignment = line.match(/\bAPP_ACCESS_TOKEN\s*=\s*(.*)$/u);

    if (!assignment) {
      return [];
    }

    return [
      {
        assignment: assignment[0],
        expression: (assignment[1] ?? "").trim(),
      },
    ];
  });
}

function readRequiredSetupSource(relativePath: string) {
  const sourcePath = join(root, relativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required setup visual source: ${relativePath}`);
  }

  return readFileSync(sourcePath, "utf8");
}

function readRequiredTopLevelFunction(source: string, functionName: string) {
  const signature = `async function ${functionName}(`;
  const functionStart = source.indexOf(signature);

  if (functionStart === -1) {
    throw new Error(`Missing required setup capture function: ${functionName}`);
  }

  const remainingSource = source.slice(functionStart + signature.length);
  const nextFunctionOffset = remainingSource.search(/^async function \w+\(/mu);
  const functionEnd =
    nextFunctionOffset === -1
      ? source.length
      : functionStart + signature.length + nextFunctionOffset;

  return source.slice(functionStart, functionEnd);
}

describe("task-first README user guide", () => {
  test("provides reproducible privacy-safe setup visuals", () => {
    const scripts = (JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> }).scripts;
    const generator = readFileSync(
      join(root, "scripts/screenshots.mjs"),
      "utf8",
    );
    const workflow = readFileSync(
      join(root, "scripts/screenshot-workflow.mjs"),
      "utf8",
    );
    const screenshotDocs = readFileSync(
      join(root, "docs/screenshots/README.md"),
      "utf8",
    );
    const popupSource = readFileSync(
      join(root, "extension/popup.html"),
      "utf8",
    );

    expect(scripts["screenshots:setup"]).toBe(
      "node scripts/screenshots.mjs --setup-only",
    );
    expect(generator).toContain('process.argv.includes("--setup-only")');
    expect(generator).toMatch(
      /const\s+SETUP_ONLY\s*=\s*process\.argv\.includes\("--setup-only"\);?/u,
    );
    for (const captureFunction of setupCaptureFunctions) {
      expect(generator).toContain(`await ${captureFunction}(context);`);
    }

    const chromeExtensionsSetup = readRequiredSetupSource(
      "scripts/chrome-extensions-setup.html",
    );
    const fixtureSource = readRequiredSetupSource(
      "scripts/screenshot-fixtures.mjs",
    );
    const popupConnectionFixture = fixtureSource.match(
      /export\s+const\s+popupConnectionFixture\s*=\s*\{[\s\S]*?^\s*\};/mu,
    );
    expect(popupConnectionFixture).not.toBeNull();
    expect(popupConnectionFixture?.[0]).toContain(
      'maskedToken: "••••••••••••••••••••••••••••••••"',
    );
    expect(popupConnectionFixture?.[0]).toContain(
      'disconnectedStatus: "Disconnected — enter a pairing code to connect."',
    );
    expect(generator).toContain("connectBtn.disabled = false;");
    expect(chromeExtensionsSetup).toMatch(
      /<p class="description">\s*Extract job posting data and send it to JobTracker\s*<\/p>/u,
    );

    const setupGeneratorSource = setupCaptureFunctions
      .map((functionName) =>
        readRequiredTopLevelFunction(generator, functionName),
      )
      .join("\n");
    const setupPrivacySources = [
      chromeExtensionsSetup,
      popupConnectionFixture?.[0] ?? "",
      setupGeneratorSource,
    ].join("\n");
    const broaderSources = [
      generator,
      workflow,
      chromeExtensionsSetup,
      fixtureSource,
      popupSource,
    ].join("\n");
    const localOrigin = "http://localhost:3000";
    const syntheticExtensionId = "abcdefghijklmnopabcdefghijklmnop";

    expect(chromeExtensionsSetup).toContain(
      "Instructional view — synthetic data",
    );
    expect(setupPrivacySources).toContain(localOrigin);
    expect(setupPrivacySources).toContain(syntheticExtensionId);

    const setupOrigins =
      setupPrivacySources.match(/https?:\/\/[^/\s"'`<>),;]+/gu) ?? [];
    expect([...new Set(setupOrigins)]).toEqual([localOrigin]);

    const extensionIds = setupPrivacySources.match(/\b[a-p]{32}\b/gu) ?? [];
    expect([...new Set(extensionIds)]).toEqual([syntheticExtensionId]);

    for (const forbiddenText of [
      "easy-job-application-tracker.vercel.app",
      "gihbagcjnmkhkekjkbfjhcbddnamaiap",
      "Bearer ",
      "/Users/",
    ]) {
      expect(broaderSources).not.toContain(forbiddenText);
    }
    expect(setupPrivacySources).not.toMatch(
      /\b(?:browser|avatar|profile)[-_ ]?(?:id|name|path|token|url)\b/iu,
    );

    for (const setupImage of setupImages) {
      const setupImagePath = join(root, "docs/screenshots", setupImage);

      expect(existsSync(setupImagePath)).toBe(true);
      const setupImageBytes = readFileSync(setupImagePath);
      expect(setupImageBytes.subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
      expect(setupImageBytes.length).toBeGreaterThan(5_000);
      expect(setupImageBytes.readUInt32BE(8)).toBe(13);
      expect(setupImageBytes.subarray(12, 16).toString("ascii")).toBe(
        "IHDR",
      );
      const expectedDimensions = setupImageDimensions.get(setupImage);
      expect(setupImageBytes.readUInt32BE(16)).toBe(
        expectedDimensions?.width,
      );
      expect(setupImageBytes.readUInt32BE(20)).toBe(
        expectedDimensions?.height,
      );
      expect(setupImageBytes.subarray(-12).toString("hex")).toBe(
        "0000000049454e44ae426082",
      );
      expect(generator).toContain(setupImage);
      expect(screenshotDocs).toContain(setupImage);
    }

    expect(screenshotDocs).toContain("npm run screenshots:setup");
    expect(screenshotDocs).toContain("synthetic");
    expect(screenshotDocs).toContain("authenticated local browser session");
    expect(screenshotDocs).toContain("separate network-blocked browser context");
    expect(generator).not.toContain(
      "easy-job-application-tracker.vercel.app",
    );
  });

  test("allows only synthetic access-token assignments", () => {
    const cases = [
      { expression: '"<second-generated-secret>"', safe: true },
      { expression: '"<access-token>"', safe: true },
      { expression: "REPLACE_WITH_GENERATED_TOKEN", safe: true },
      { expression: '"YOUR_ACCESS_TOKEN"', safe: true },
      { expression: "TEST_ONLY_ACCESS_TOKEN", safe: true },
      { expression: '"test-only-access-token-fixture"', safe: true },
      { expression: '"test_only_access_token_fixture"', safe: true },
      {
        expression:
          '"ci-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        safe: true,
      },
      { expression: '""', safe: true },
      {
        expression:
          '"$(node -e \'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))\')"',
        safe: false,
      },
      {
        expression:
          '"generated-prod-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        safe: false,
      },
      { expression: '"prod-secret-test-only-abc123"', safe: false },
      { expression: '"prod_secret_test_only_abc123"', safe: false },
      { expression: '"fixed-test-only-access-token"', safe: false },
      {
        expression: '"GENERATE_WITH_OPENSSL_RAND_BASE64_32"',
        safe: false,
      },
      { expression: '"$(openssl rand -base64 32)"', safe: false },
      { expression: '"$(curl https://example.com/token)"', safe: false },
    ];

    for (const { expression, safe } of cases) {
      expect({
        expression,
        safe: isSafeDocumentedTokenExpression(expression),
      }).toEqual({ expression, safe });
    }
  });

  test("guides a new user from local server setup to the first saved job", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const expectedH2Headings = [
      "## What You Can Do",
      "## How JobTracker Works",
      "## Prerequisites",
      "## Local Quick Start",
      "## Install the Chrome Extension",
      "## Connect the Extension",
      "## Save Your First Job",
      "## Set Up Resume Matching",
      "## Optional Features",
      "## Troubleshooting",
      "## Production Deployment",
      "## Database Migration Notes",
      "## Development and Verification",
      "## Documentation",
      "## License",
    ];
    const requiredText = [
      "Chrome extension → JobTracker server → PostgreSQL",
      "The extension is not standalone",
      "Node.js 22.22.2",
      "npm ci",
      "node:crypto",
      "APP_ACCESS_TOKEN",
      "chrome-extension://<extension-id>",
      "CORS_ALLOWED_ORIGINS",
      "chrome://extensions",
      "Load unpacked",
      "The pairing-code field is cleared after a successful connection",
      "Settings → Chrome extension installations",
      "one-time pairing code",
      "docs/operations/production-runbook.md",
    ];
    const requiredSetupImageReferences = setupImages.map(
      (setupImage) => `docs/screenshots/${setupImage}`,
    );

    expect(readme).not.toContain("GENERATE_WITH_OPENSSL_RAND_BASE64_32");
    expect(readme).not.toContain(
      "Paste the value of `APP_ACCESS_TOKEN` into **Access Token**",
    );

    const unsafeTokenAssignments = readDocumentedTokenAssignments(
      readme,
    ).filter(
      ({ expression }) => !isSafeDocumentedTokenExpression(expression),
    );

    expect(unsafeTokenAssignments).toEqual([]);

    const actualH2Headings = readme.match(/^## [^\r\n]+$/gmu) ?? [];

    expect({
      actualH2Headings,
      missingSetupImageReferences: requiredSetupImageReferences.filter(
        (imageReference) => !readme.includes(imageReference),
      ),
      missingText: requiredText.filter((text) => !readme.includes(text)),
    }).toEqual({
      actualH2Headings: expectedH2Headings,
      missingSetupImageReferences: [],
      missingText: [],
    });

    expect(readme).toContain(
      "Chrome asks for access to the configured JobTracker server origin",
    );
    expect(readme).not.toContain(
      "Site Access permission request for the current job site",
    );
    expect(readme).toContain(
      "placeholder values copied from `.env.example` are intentionally rejected",
    );
    expect(readme).toContain("fs.constants.COPYFILE_EXCL");
    expect(readme).toContain(
      "preserves it and does not overwrite your credentials",
    );
    expect(readme).toContain(
      "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
    );
    expect(readme).toContain("createdb jobtracker");
    expect(readme).not.toContain("createdb <db-name>");
    expect(readme).toContain("| Symptom | Likely cause | Action |");
    expect(readme).toMatch(
      /\| Resume upload fails \|[^\r\n]+\|[^\r\n]+\|/u,
    );
  });

  test("documents final-review operational accuracy corrections", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");

    expect(readme).not.toContain("API key and model settings");
    expect(readme).toContain("Provider models are selected internally");
    expect(readme).toContain(
      "Reserved URL characters in the database username, password, or database name must be percent-encoded",
    );
    expect(readme).toContain(
      "Some Chrome versions may retain a previously requested server origin",
    );
    expect(readme).toContain(
      "The popup cleanup warning and the server-origin permission toggle are authoritative",
    );
    expect(readme).toContain("npm run check:audit");
    expect(readme).toContain(
      "CI enforces the dependency-audit policy",
    );
  });

  test("summarizes the staged two-gate Production rollout", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8").replace(
      /\s+/gu,
      " ",
    );

    for (const requiredText of [
      "APPLICATION_IDENTITY_WRITES_ENABLED",
      "APPLICATION_WRITES_ENABLED",
      "server-only",
      "missing value defaults closed",
      "invalid value",
      "Production must set it explicitly",
      "identity=0,writes=1",
      "identity=1,writes=0",
      "identity=1,writes=1",
      "Production candidate",
      "Ready",
      "exact intended Git SHA",
      "no canonical alias",
      "while unpaused",
      "2 × maxDuration",
      "at least 60 seconds",
      "authenticated negative probe",
      "503 DEPLOYMENT_PAUSED",
      "without redeploying",
      "all eight persistent mutations",
      "Settings GET does not create a row",
      "lastUsedAt/updatedAt",
      "smoke",
      "bounded cleanup",
      "external writers are resumed last",
      "rollback target",
    ]) {
      expect(readme).toContain(requiredText);
    }
    expect(readme).not.toMatch(
      /(?:build|deploy|deployment|promotion)[^.]{0,100}(?:while|remains) Vercel (?:was|remains) paused/iu,
    );
  });
});
