import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const CHECKOUT_SHA = "df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";

type MonitorWorkflow = Readonly<{
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Readonly<{
    monitor: Readonly<{
      "runs-on": string;
      "timeout-minutes": number;
      env: Record<string, string>;
      steps: readonly unknown[];
    }>;
  }>;
}>;

describe("production monitor workflow contract", () => {
  it("runs the authenticated monitor hourly and manually with bounded access", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const source = readFileSync(
      join(root, ".github/workflows/production-monitor.yml"),
      "utf8",
    );
    const workflow = parse(source) as MonitorWorkflow;

    expect(packageJson.scripts["check:production"]).toBe(
      "node scripts/check-production-stats.mjs",
    );
    expect(workflow.on).toEqual({
      schedule: [{ cron: "17 * * * *" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.monitor).toMatchObject({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      env: {
        PRODUCTION_APP_URL: "${{ vars.PRODUCTION_APP_URL }}",
        PRODUCTION_APP_ACCESS_TOKEN:
          "${{ secrets.PRODUCTION_APP_ACCESS_TOKEN }}",
      },
    });
    expect(workflow.jobs.monitor.steps).toEqual([
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
      { name: "Check authenticated production stats", run: "npm run check:production" },
    ]);
    expect(source).not.toMatch(/curl|response|body|set -x/iu);
  });
});
