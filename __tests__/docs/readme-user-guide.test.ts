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

const normalCaptureFunctions = [
  "captureDashboard",
  "captureSettingsResume",
  "captureExtensionPopup",
  "captureKeywordAnalysis",
  "captureSettingsLlm",
];

const setupCaptureFunctions = [
  "captureChromeLoadUnpacked",
  "captureExtensionConnect",
  "captureExtensionConnected",
];

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
    expect(generator).toMatch(
      /import\s+\{\s*installScreenshotNetworkPolicy\s*\}\s+from\s+"\.\/screenshot-network-policy\.mjs";/u,
    );
    expect(generator).toContain("installScreenshotNetworkPolicy(context)");
    expect(generator).toContain("setupNetworkPolicy.assertNoNetworkAttempts()");

    const normalCaptureGate = generator.match(
      /if\s*\(\s*!SETUP_ONLY\s*\)\s*\{(?<normalCaptures>[\s\S]*?)\}/u,
    );
    expect(normalCaptureGate).not.toBeNull();

    const normalCaptureSource =
      normalCaptureGate?.groups?.normalCaptures ?? "";
    for (const captureFunction of normalCaptureFunctions) {
      expect(normalCaptureSource).toContain(
        `await ${captureFunction}(context);`,
      );
    }

    const setupCaptureSource = normalCaptureGate
      ? generator.replace(normalCaptureGate[0], "")
      : generator;
    for (const captureFunction of setupCaptureFunctions) {
      expect(setupCaptureSource).toContain(
        `await ${captureFunction}(context);`,
      );
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
      'disconnectedStatus: "Disconnected — enter an access token to connect."',
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
    expect(generator).not.toContain(
      "easy-job-application-tracker.vercel.app",
    );
  });
});
