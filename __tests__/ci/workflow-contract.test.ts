import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const CHECKOUT_SHA = "df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";

type WorkflowStep = Readonly<{
  name: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
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
  }>;
}>;

describe("deployment verification contract", () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  it("provides deterministic typecheck, test, and extension checks", () => {
    expect(packageJson.scripts).toMatchObject({
      typecheck: "next typegen && tsc --noEmit",
      "test:ci": "jest --runInBand",
    });
    expect(packageJson.scripts?.["check:extension"]).toContain(
      "node --check extension/background.js",
    );
    expect(packageJson.scripts?.["check:extension"]).toContain(
      "extension/manifest.json",
    );
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
    expect(job["timeout-minutes"]).toBe(25);
    expect(job.services).toEqual({
      postgres: {
        image: "postgres:16-alpine",
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
    ]);
    expect(workflowSource).toContain(`# v6.0.3\n`);
    expect(workflowSource).toContain(`# v6.5.0\n`);
    expect(workflowSource).not.toContain("secrets.");
    expect(job.env).not.toHaveProperty("NODE_ENV");
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
