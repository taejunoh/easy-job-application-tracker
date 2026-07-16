import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workflowUrl = pathToFileURL(
  join(__dirname, "../../scripts/screenshot-workflow.mjs"),
).href;

const runner = `
import {
  authenticateScreenshotContext,
  runScreenshotWorkflow,
} from ${JSON.stringify(workflowUrl)};

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const scenario = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const events = [];

if (scenario.kind === "authenticate") {
  const context = {
    request: {
      async post(url, options) {
        events.push({ type: "post", url, options });
        return {
          ok: () => scenario.ok,
          status: () => scenario.status,
        };
      },
    },
  };

  let error = null;
  try {
    await authenticateScreenshotContext(context, {
      baseUrl: "http://localhost:3000",
      accessToken: "test-only-access-token-fixture",
    });
  } catch (cause) {
    error = cause.message;
  }
  process.stdout.write(JSON.stringify({ events, error }));
} else {
  let contextNumber = 0;
  const contexts = [];
  const browser = {
    async newContext(options) {
      contextNumber += 1;
      const name = contextNumber === 1 && !scenario.setupOnly ? "app" : "setup";
      const context = {
        name,
        async close() {
          events.push("close:" + name);
          if (scenario.rejectClose === name) {
            throw new Error("close failed: " + name);
          }
        },
      };
      contexts.push(context);
      events.push({ type: "new-context", name, options });
      return context;
    },
    async close() {
      events.push("close:browser");
    },
  };

  let error = null;
  try {
    await runScreenshotWorkflow({
      browser,
      setupOnly: scenario.setupOnly,
      appContextOptions: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        serviceWorkers: "block",
        locale: "en-US",
        timezoneId: "UTC",
      },
      setupContextOptions: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        serviceWorkers: "block",
      },
      authenticateAppContext: async (context) => {
        events.push("authenticate:" + context.name);
      },
      captureAppScreenshots: async (context) => {
        events.push("capture-app:" + context.name);
      },
      installSetupNetworkPolicy: async (context) => {
        events.push("install-policy:" + context.name);
        return {
          assertNoNetworkAttempts() {
            events.push("assert-policy:" + context.name);
          },
        };
      },
      captureSetupScreenshots: async (context) => {
        events.push("capture-setup:" + context.name);
        if (scenario.rejectSetupCapture) {
          throw new Error("setup capture failed");
        }
      },
    });
  } catch (cause) {
    error = cause.message;
  }
  process.stdout.write(JSON.stringify({ events, error }));
}
`;

type WorkflowScenario = {
  kind: "workflow";
  setupOnly: boolean;
  rejectClose?: "app" | "setup";
  rejectSetupCapture?: boolean;
};

type AuthenticateScenario = {
  kind: "authenticate";
  ok: boolean;
  status: number;
};

function runScenario(
  scenario: WorkflowScenario | AuthenticateScenario,
): { events: Array<string | Record<string, unknown>>; error: string | null } {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", runner],
    {
      input: JSON.stringify(scenario),
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    events: Array<string | Record<string, unknown>>;
    error: string | null;
  };
}

describe("screenshot workflow orchestration", () => {
  test("authenticates app captures before using a separate offline setup context", () => {
    const result = runScenario({ kind: "workflow", setupOnly: false });

    expect(result.error).toBeNull();
    expect(result.events).toEqual([
      {
        type: "new-context",
        name: "app",
        options: {
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 2,
          serviceWorkers: "block",
          locale: "en-US",
          timezoneId: "UTC",
        },
      },
      "authenticate:app",
      "capture-app:app",
      {
        type: "new-context",
        name: "setup",
        options: {
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 2,
          serviceWorkers: "block",
        },
      },
      "install-policy:setup",
      "capture-setup:setup",
      "assert-policy:setup",
      "close:setup",
      "close:app",
      "close:browser",
    ]);
  });

  test("uses only the offline setup context in setup-only mode", () => {
    const result = runScenario({ kind: "workflow", setupOnly: true });

    expect(result.error).toBeNull();
    expect(result.events).toEqual([
      {
        type: "new-context",
        name: "setup",
        options: {
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 2,
          serviceWorkers: "block",
        },
      },
      "install-policy:setup",
      "capture-setup:setup",
      "assert-policy:setup",
      "close:setup",
      "close:browser",
    ]);
  });

  test("closes every remaining resource when one context close rejects", () => {
    const result = runScenario({
      kind: "workflow",
      setupOnly: false,
      rejectClose: "setup",
    });

    expect(result.error).toBe("close failed: setup");
    expect(result.events.slice(-3)).toEqual([
      "close:setup",
      "close:app",
      "close:browser",
    ]);
  });

  test("asserts the offline policy even when a setup capture fails", () => {
    const result = runScenario({
      kind: "workflow",
      setupOnly: false,
      rejectSetupCapture: true,
    });

    expect(result.error).toBe("setup capture failed");
    expect(result.events).toContain("assert-policy:setup");
    expect(result.events.slice(-3)).toEqual([
      "close:setup",
      "close:app",
      "close:browser",
    ]);
  });
});

describe("screenshot session authentication", () => {
  test("posts the local token to the same-origin session endpoint", () => {
    const result = runScenario({ kind: "authenticate", ok: true, status: 200 });

    expect(result).toEqual({
      events: [
        {
          type: "post",
          url: "http://localhost:3000/api/auth/session",
          options: {
            headers: { Origin: "http://localhost:3000" },
            data: { token: "test-only-access-token-fixture" },
          },
        },
      ],
      error: null,
    });
  });

  test("reports only the response status when session creation fails", () => {
    const result = runScenario({ kind: "authenticate", ok: false, status: 401 });

    expect(result.error).toBe(
      "Could not create the local screenshot session (HTTP 401).",
    );
    expect(result.error).not.toContain("test-only-access-token-fixture");
  });
});
