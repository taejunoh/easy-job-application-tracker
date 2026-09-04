import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const CHECKOUT_SHA = "df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";

type WorkflowStep = Readonly<{
  name: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}>;

type Workflow = Readonly<{
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Readonly<{ group: string; "cancel-in-progress": boolean }>;
  jobs: Readonly<{
    verify: Readonly<{
      "runs-on": string;
      "timeout-minutes": number;
      services: Record<string, unknown>;
      env: Record<string, string>;
      steps: readonly WorkflowStep[];
    }>;
    "backup-interruption": Readonly<{
      "runs-on": string;
      "timeout-minutes": number;
      env: Record<string, string>;
      steps: readonly WorkflowStep[];
    }>;
  }>;
}>;

describe("deployment verification contract", () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it("provides deterministic typecheck, test, and extension checks", () => {
    expect(packageJson.scripts).toMatchObject({
      dev:
        "node --import ./scripts/validate-startup-env-development.mjs node_modules/next/dist/bin/next dev",
      start:
        "node --import ./scripts/validate-startup-env-production.mjs node_modules/next/dist/bin/next start",
      typecheck: "next typegen && tsc --noEmit",
      "test:ci": "jest --runInBand",
      "check:audit": "node scripts/check-audit.mjs",
      "check:startup-env": "node scripts/verify-invalid-startup.mjs",
      "backfill:application-identities":
        "node scripts/backfill-application-identities.mjs",
      "test:backup:docker":
        "RUN_BACKUP_DOCKER_INTEGRATION=1 jest --runInBand __tests__/scripts/create-snapshot-backup.docker.integration.test.ts",
    });
    expect(packageJson.dependencies).toMatchObject({
      "@next/env": "16.3.0",
      next: "16.3.0",
    });
    expect(packageJson.scripts?.["check:extension"]).toContain(
      "node --check extension/background.js",
    );
    expect(packageJson.scripts?.["check:extension"]).toContain(
      "extension/manifest.json",
    );
  });

  it("pins the supported Node 22 runtime everywhere", () => {
    const packageLock = JSON.parse(
      readFileSync(join(root, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { engines?: { node?: string } }>;
    };
    const workflowSource = readFileSync(
      join(root, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(readFileSync(join(root, ".nvmrc"), "utf8").trim()).toBe(
      "22.22.2",
    );
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe(
      "22.22.2",
    );
    expect(packageJson).toMatchObject({
      engines: { node: ">=22.22.2 <23" },
    });
    expect(packageLock.packages?.[""]?.engines).toEqual({
      node: ">=22.22.2 <23",
    });
    expect(workflowSource).toContain('node-version: "22.22.2"');
  });

  it("documents the only startup commands that enforce pre-listen validation", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const loader = readFileSync(
      join(root, "scripts/load-and-validate-startup-env.mjs"),
      "utf8",
    );
    const developmentPreloader = readFileSync(
      join(root, "scripts/validate-startup-env-development.mjs"),
      "utf8",
    );
    const productionPreloader = readFileSync(
      join(root, "scripts/validate-startup-env-production.mjs"),
      "utf8",
    );

    expect(loader).toContain("loadEnvConfig(process.cwd(), isDevelopment)");
    expect(loader).toContain("export function loadAndValidateStartupEnv");
    expect(developmentPreloader).toContain(
      "loadAndValidateStartupEnv(true)",
    );
    expect(productionPreloader).toContain(
      "loadAndValidateStartupEnv(false)",
    );
    expect(readme).toContain("npm start");
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("Direct `next start` and `npx next`");
    expect(readme).toContain("unsupported");
    expect(readme).toContain("request-blocking defense in depth");
    expect(readme).toContain("validate-startup-env-development.mjs");
    expect(readme).toContain("validate-startup-env-production.mjs");
  });

  it("parses as the exact Node and PostgreSQL deployment gate", () => {
    const workflowSource = readFileSync(
      join(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const workflow = parse(workflowSource) as Workflow;
    const job = workflow.jobs.verify;

    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": true,
    });
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(40);
    expect(job.services).toEqual({
      postgres: {
        image:
          "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
        env: {
          POSTGRES_USER: "jobtracker",
          POSTGRES_PASSWORD: "jobtracker",
          POSTGRES_DB: "jobtracker_ci",
        },
        ports: ["5432:5432"],
        options:
          '--health-cmd "pg_isready -U jobtracker -d jobtracker_ci" --health-interval 10s --health-timeout 5s --health-retries 5',
      },
    });
    expect(job.env).toEqual({
      DATABASE_URL:
        "postgresql://jobtracker:jobtracker@127.0.0.1:5432/jobtracker_ci",
      ENCRYPTION_SECRET:
        "ci-encryption-secret-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      APP_ACCESS_TOKEN: "ci-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      APP_BASE_URL: "https://jobtracker.test",
      CORS_ALLOWED_ORIGINS:
        "https://jobtracker.test,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      RUN_DATABASE_INTEGRATION: "1",
      ALLOW_DESTRUCTIVE_DATABASE_TESTS: "jobtracker-ci-delete-all",
      APPLICATION_IDENTITY_WRITES_ENABLED: "1",
    });
    expect(job.steps).toEqual([
      {
        name: "Check out repository",
        uses: `actions/checkout@${CHECKOUT_SHA}`,
      },
      {
        name: "Set up Node.js",
        uses: `actions/setup-node@${SETUP_NODE_SHA}`,
        with: { "node-version": "22.22.2", cache: "npm" },
      },
      {
        name: "Capture PostgreSQL service address",
        env: {
          POSTGRES_SERVICE_CONTAINER_ID: "${{ job.services.postgres.id }}",
        },
        run: "address=\"$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \"$POSTGRES_SERVICE_CONTAINER_ID\")\"\nprintf 'EXPECTED_DATABASE_SERVER_ADDRESS=%s\\n' \"$address\" >> \"$GITHUB_ENV\"\n",
      },
      { name: "Install dependencies", run: "npm ci" },
      {
        name: "Install Playwright headless shell",
        run: "npx playwright install --with-deps --only-shell chromium",
      },
      {
        name: "Enforce dependency audit policy",
        run: "npm run check:audit",
      },
      { name: "Generate Prisma client", run: "npx prisma generate" },
      { name: "Validate Prisma schema", run: "npx prisma validate" },
      { name: "Apply database migrations", run: "npx prisma migrate deploy" },
      { name: "Verify migration status", run: "npx prisma migrate status" },
      {
        name: "Verify database schema matches Prisma schema",
        run: "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
      },
      { name: "Check extension assets", run: "npm run check:extension" },
      {
        name: "Run unit and database integration tests",
        run: "npm run test:ci",
      },
      { name: "Lint", run: "npm run lint" },
      { name: "Typecheck", run: "npm run typecheck" },
      { name: "Build production application", run: "npm run build" },
      {
        name: "Verify invalid deployment fails before ready",
        run: "npm run check:startup-env",
      },
    ]);
    expect(workflowSource).toContain(`# v6.0.3\n`);
    expect(workflowSource).toContain(`# v6.5.0\n`);
    expect(workflowSource).not.toContain("secrets.");
    expect(job.env).not.toHaveProperty("NODE_ENV");
  });

  it("runs the real extension in bundled Chromium against isolated PostgreSQL 17", () => {
    const workflowSource = readFileSync(
      join(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const workflow = parse(workflowSource) as Workflow & {
      jobs: Record<string, {
        "runs-on": string;
        "timeout-minutes": number;
        services: Record<string, unknown>;
        env: Record<string, string>;
        steps: WorkflowStep[];
      }>;
    };
    const job = workflow.jobs["extension-e2e"];

    expect(job).toBeDefined();
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(25);
    expect(job.services).toEqual({
      postgres: {
        image:
          "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
        env: {
          POSTGRES_USER: "jobtracker",
          POSTGRES_PASSWORD: "jobtracker",
          POSTGRES_DB: "jobtracker_extension_e2e_test",
        },
        ports: ["5432:5432"],
        options:
          '--health-cmd "pg_isready -U jobtracker -d jobtracker_extension_e2e_test" --health-interval 10s --health-timeout 5s --health-retries 5',
      },
    });
    expect(job.env).toEqual({
      DATABASE_URL:
        "postgresql://jobtracker:jobtracker@127.0.0.1:5432/jobtracker_extension_e2e_test",
      ENCRYPTION_SECRET:
        "extension-e2e-encryption-secret-cccccccccccc",
      APP_ACCESS_TOKEN:
        "extension-e2e-access-token-aaaaaaaaaaaaaaaa",
      APP_BASE_URL: "https://127.0.0.1:3100",
      CORS_ALLOWED_ORIGINS:
        "https://127.0.0.1:3100,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      RUN_EXTENSION_E2E: "1",
      ALLOW_DESTRUCTIVE_EXTENSION_E2E:
        "jobtracker-extension-e2e-delete-all",
      APPLICATION_IDENTITY_WRITES_ENABLED: "1",
    });
    expect(job.steps).toEqual([
      {
        name: "Check out repository",
        uses: `actions/checkout@${CHECKOUT_SHA}`,
      },
      {
        name: "Set up Node.js",
        uses: `actions/setup-node@${SETUP_NODE_SHA}`,
        with: { "node-version": "22.22.2", cache: "npm" },
      },
      {
        name: "Capture PostgreSQL service address",
        env: {
          POSTGRES_SERVICE_CONTAINER_ID: "${{ job.services.postgres.id }}",
        },
        run: "address=\"$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \"$POSTGRES_SERVICE_CONTAINER_ID\")\"\nprintf 'EXPECTED_DATABASE_SERVER_ADDRESS=%s\\n' \"$address\" >> \"$GITHUB_ENV\"\n",
      },
      { name: "Install dependencies", run: "npm ci" },
      {
        name: "Install bundled Chromium",
        run: "npx playwright install --with-deps chromium",
      },
      { name: "Build production application", run: "npm run build" },
      {
        name: "Run extension end-to-end journeys",
        run: "npm run test:extension:e2e",
      },
      {
        name: "Upload sanitized extension diagnostics",
        if: "failure()",
        uses:
          "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        with: {
          name: "extension-e2e-diagnostics",
          path: ".artifacts/extension-e2e/",
          "if-no-files-found": "ignore",
          "retention-days": 7,
        },
      },
    ]);
    expect(workflowSource).not.toContain("secrets.");
  });

  it("runs the real digest-pinned PostgreSQL 17 backup interruption proof", () => {
    const workflow = parse(
      readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
    ) as Workflow;
    const job = workflow.jobs["backup-interruption"];

    expect(job).toMatchObject({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      env: {
        PG17_IMAGE:
          "docker.io/library/postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
      },
    });
    expect(job.steps).toEqual([
      {
        name: "Check out repository",
        uses: `actions/checkout@${CHECKOUT_SHA}`,
      },
      {
        name: "Set up Node.js",
        uses: `actions/setup-node@${SETUP_NODE_SHA}`,
        with: { "node-version": "22.22.2", cache: "npm" },
      },
      { name: "Install dependencies", run: "npm ci" },
      {
        name: "Pull digest-pinned PostgreSQL 17 image",
        run: 'docker pull "$PG17_IMAGE"',
      },
      {
        name: "Run PostgreSQL 17 backup interruption proof",
        run: "npm run test:backup:docker",
      },
    ]);
  });

  it("uses only local typography sources", () => {
    const matches = sourceFiles(join(root, "src")).filter((path) =>
      readFileSync(path, "utf8").includes("next/font/google"),
    );
    const css = readFileSync(join(root, "src/app/globals.css"), "utf8");

    expect(matches).toEqual([]);
    expect(css).toContain('"Avenir Next"');
    expect(css).toContain('"Segoe UI"');
    expect(css).toContain('"Helvetica Neue"');
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|jsx|css)$/u.test(entry.name) ? [path] : [];
  });
}
