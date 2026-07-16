import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const policyUrl = pathToFileURL(
  join(__dirname, "../../scripts/screenshot-network-policy.mjs"),
).href;

const runner = `
import { installScreenshotNetworkPolicy } from ${JSON.stringify(policyUrl)};

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const abortReasons = [];
const closeOptions = [];
const context = {
  async route(predicate, handler) {
    this.httpPredicate = predicate;
    this.httpHandler = handler;
  },
  async routeWebSocket(predicate, handler) {
    this.webSocketPredicate = predicate;
    this.webSocketHandler = handler;
  },
};

const policy = await installScreenshotNetworkPolicy(context);
const predicateResults = request.predicateUrls.map((url) => ({
  url,
  http: context.httpPredicate(new URL(url)),
  webSocket: context.webSocketPredicate(new URL(url)),
}));

for (const event of request.events) {
  const parsed = new URL(event.url);
  if (event.kind === "http" && context.httpPredicate(parsed)) {
    await context.httpHandler({
      request: () => ({ url: () => event.url }),
      abort: async (reason) => abortReasons.push(reason),
    });
  }
  if (event.kind === "webSocket" && context.webSocketPredicate(parsed)) {
    await context.webSocketHandler({
      url: () => event.url,
      close: async (options) => closeOptions.push(options),
      connectToServer: () => { throw new Error("must not connect to server"); },
    });
  }
}

const attemptedUrls = policy.getAttemptedUrls();
attemptedUrls.push("mutated-copy");
const attemptedUrlsAfterMutation = policy.getAttemptedUrls();
let assertionError = null;
try {
  policy.assertNoNetworkAttempts();
} catch (error) {
  assertionError = error.message;
}

process.stdout.write(JSON.stringify({
  predicateResults,
  abortReasons,
  closeOptions,
  attemptedUrls: attemptedUrls.slice(0, -1),
  attemptedUrlsAfterMutation,
  assertionError,
}));
`;

type Scenario = {
  predicateUrls?: string[];
  events?: Array<{ kind: "http" | "webSocket"; url: string }>;
};

type ScenarioResult = {
  predicateResults: Array<{ url: string; http: boolean; webSocket: boolean }>;
  abortReasons: string[];
  closeOptions: Array<{ code: number; reason: string }>;
  attemptedUrls: string[];
  attemptedUrlsAfterMutation: string[];
  assertionError: string | null;
};

function runScenario({ predicateUrls = [], events = [] }: Scenario = {}) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", runner],
    {
      input: JSON.stringify({ predicateUrls, events }),
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || `policy process exited ${result.status}`);
  }

  return JSON.parse(result.stdout) as ScenarioResult;
}

describe("setup screenshot network policy", () => {
  test("allows a fresh policy and returns defensive attempt copies", () => {
    const result = runScenario({
      predicateUrls: ["http://localhost:3000"],
    });

    expect(result.predicateResults).toEqual([
      { url: "http://localhost:3000", http: true, webSocket: false },
    ]);
    expect(result.attemptedUrls).toEqual([]);
    expect(result.attemptedUrlsAfterMutation).toEqual([]);
    expect(result.assertionError).toBeNull();
  });

  test("blocks, records, and reports HTTP and HTTPS attempts in order", () => {
    const urls = [
      "http://localhost:3000/api/settings",
      "https://example.invalid/asset.css",
      "http://localhost:3000/api/settings",
    ];
    const result = runScenario({
      events: urls.map((url) => ({ kind: "http", url })),
    });

    expect(result.abortReasons).toEqual([
      "blockedbyclient",
      "blockedbyclient",
      "blockedbyclient",
    ]);
    expect(result.attemptedUrls).toEqual(urls);
    expect(result.attemptedUrlsAfterMutation).toEqual(urls);
    expect(result.assertionError).toBe(
      "Setup-only screenshots must use static HTML and synthetic fixtures only.\n" +
        "Blocked network attempts:\n" +
        urls.map((url) => `- ${url}`).join("\n"),
    );
  });

  test("closes, records, and reports WebSocket attempts without connecting", () => {
    const urls = ["ws://localhost:3000/socket", "wss://example.invalid/socket"];
    const result = runScenario({
      events: urls.map((url) => ({ kind: "webSocket", url })),
    });

    expect(result.closeOptions).toEqual([
      { code: 1008, reason: "Setup screenshots forbid network access" },
      { code: 1008, reason: "Setup screenshots forbid network access" },
    ]);
    expect(result.attemptedUrls).toEqual(urls);
    expect(result.assertionError).toContain(urls[0]);
    expect(result.assertionError).toContain(urls[1]);
  });

  test("ignores non-network URL schemes", () => {
    const predicateUrls = [
      "about:blank",
      "data:text/plain,fixture",
      "blob:http://localhost:3000/fixture",
      "file:///tmp/fixture.html",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html",
    ];
    const result = runScenario({ predicateUrls });

    expect(result.predicateResults).toEqual(
      predicateUrls.map((url) => ({ url, http: false, webSocket: false })),
    );
    expect(result.attemptedUrlsAfterMutation).toEqual([]);
    expect(result.assertionError).toBeNull();
  });
});
