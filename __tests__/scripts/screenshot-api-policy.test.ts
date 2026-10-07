import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const policyUrl = pathToFileURL(
  join(__dirname, "../../scripts/screenshot-api-policy.mjs"),
).href;

const runner = `
import { installSyntheticApiPolicy } from ${JSON.stringify(policyUrl)};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const scenario = JSON.parse(Buffer.concat(chunks).toString("utf8"));
let predicate;
let handler;
const fulfilled = [];
const aborted = [];
const context = { async route(match, callback) { predicate = match; handler = callback; } };
const policy = await installSyntheticApiPolicy(context);
for (const request of scenario.requests) {
  const parsed = new URL(request.url);
  if (!predicate(parsed)) continue;
  const route = {
    request: () => ({ method: () => request.method, url: () => request.url }),
    fulfill: async (response) => fulfilled.push({ request, response }),
    abort: async () => aborted.push(request),
  };
  await handler(route);
}
let error = null;
try { policy.assertOnlySyntheticApiRequests(); } catch (cause) { error = cause.message; }
process.stdout.write(JSON.stringify({ fulfilled, aborted, error }));
`;

function run(requests: Array<{ method: string; url: string }>) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runner], {
    input: JSON.stringify({ requests }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || `process exited ${result.status}`);
  return JSON.parse(result.stdout) as {
    fulfilled: Array<{ request: { method: string; url: string }; response: { body: string } }>;
    aborted: Array<{ method: string; url: string }>;
    error: string | null;
  };
}

describe("synthetic app screenshot API policy", () => {
  test("serves only expected fixture-backed reads", () => {
    const result = run([
      { method: "GET", url: "http://127.0.0.1:3107/api/stats" },
      { method: "GET", url: "http://127.0.0.1:3107/api/settings?includeResume=true" },
      { method: "GET", url: "http://127.0.0.1:3107/api/extension/installations" },
    ]);

    expect(result.fulfilled.map(({ request }) => new URL(request.url).pathname)).toEqual([
      "/api/stats", "/api/settings", "/api/extension/installations",
    ]);
    expect(result.fulfilled[2].response.body).toContain('"installations":[]');
    expect(result.aborted).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("aborts unknown routes and wrong methods without exposing query strings", () => {
    const result = run([
      { method: "GET", url: "http://127.0.0.1:3107/api/private?token=synthetic-secret" },
      { method: "POST", url: "http://127.0.0.1:3107/api/settings?token=synthetic-secret" },
      { method: "GET", url: "http://127.0.0.1:3107/api/settings?includeResume=false" },
    ]);

    expect(result.aborted).toHaveLength(3);
    expect(result.error).toContain("GET request to an unexpected API route");
    expect(result.error).toContain("POST request to an unexpected API route");
    expect(result.error).not.toContain("/api/private");
    expect(result.error).not.toContain("synthetic-secret");
  });
});
