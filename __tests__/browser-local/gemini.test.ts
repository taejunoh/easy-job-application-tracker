/** @jest-environment node */
import { extractJobDetails } from "../../src/browser-local/ai/gemini";

const apiKey = "synthetic-gemini-fixture-key";
const posting = "Morrow Works is hiring a Tool Designer.";
const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

function candidate(text: string, finishReason = "STOP") {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
  };
}

beforeEach(() => {
  jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fetch"));
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("sends only the pasted posting as user content to the fixed Gemini endpoint", async () => {
  const fetch = jest.mocked(globalThis.fetch).mockResolvedValue(
    Response.json(candidate('{"company":"  Morrow Works ","jobTitle":" Tool Designer  "}')),
  );
  const controller = new AbortController();
  const first8000 = posting.padEnd(8000, "x");

  await expect(extractJobDetails(apiKey, first8000, controller.signal))
    .resolves.toEqual({ company: "Morrow Works", jobTitle: "Tool Designer" });

  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(endpoint);
  expect(init).toMatchObject({
    method: "POST",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: controller.signal,
  });
  const headers = new Headers(init?.headers);
  expect(headers.get("x-goog-api-key")).toBe(apiKey);
  expect(headers.get("content-type")).toBe("application/json");
  const body = String(init?.body);
  expect(body).not.toContain(apiKey);
  expect(JSON.parse(body)).toEqual({
    systemInstruction: { parts: [{ text: expect.any(String) }] },
    contents: [{ role: "user", parts: [{ text: first8000 }] }],
    generationConfig: expect.objectContaining({
      maxOutputTokens: 512,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["company", "jobTitle"],
        properties: {
          company: { type: ["string", "null"] },
          jobTitle: { type: ["string", "null"] },
        },
      },
    }),
  });
});

test("accepts null and normalizes whitespace-only fields to null", async () => {
  jest.mocked(globalThis.fetch).mockResolvedValue(
    Response.json(candidate('{"company":null,"jobTitle":"   "}')),
  );
  await expect(extractJobDetails(apiKey, posting)).resolves.toEqual({
    company: null,
    jobTitle: null,
  });
});

test.each([
  [401, /key/i],
  [403, /key/i],
  [429, /rate|limit/i],
  [500, /request/i],
])("safely maps HTTP %i without reading the response body or retrying", async (status, message) => {
  const response = new Response(apiKey + posting, { status });
  const fetch = jest.mocked(globalThis.fetch).mockResolvedValue(response);
  const error = await extractJobDetails(apiKey, posting).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(message);
  expect(String(error)).not.toContain(apiKey);
  expect(String(error)).not.toContain(posting);
  expect(error).not.toHaveProperty("cause");
  expect(response.bodyUsed).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ["bad JSON in the HTTP body", () => new Response(posting)],
  ["missing candidate", () => Response.json({ candidates: [] })],
  ["bad JSON in the candidate", () => Response.json(candidate(posting))],
  ["missing field", () => Response.json(candidate('{"company":null}'))],
  ["extra field", () => Response.json(candidate('{"company":null,"jobTitle":null,"extra":null}'))],
  ["newline in a field", () => Response.json(candidate(JSON.stringify({ company: "Morrow\nWorks", jobTitle: null })))],
  ["carriage return in a field", () => Response.json(candidate(JSON.stringify({ company: null, jobTitle: "Tool Designer\r" })))],
  ["wrong field type", () => Response.json(candidate('{"company":1,"jobTitle":null}'))],
  ["oversized field", () => Response.json(candidate(JSON.stringify({ company: "x".repeat(257), jobTitle: null })))],
  ["incomplete candidate", () => Response.json(candidate('{"company":null,"jobTitle":null}', "MAX_TOKENS"))],
])("rejects a malformed response with %s", async (_label, response) => {
  jest.mocked(globalThis.fetch).mockResolvedValue(response());
  await expect(extractJobDetails(apiKey, posting)).rejects.toThrow(
    "Gemini returned an invalid response.",
  );
});

test("hides fetch rejection details and makes one request", async () => {
  const fetch = jest.mocked(globalThis.fetch).mockRejectedValue(new Error(apiKey + posting));
  await expect(extractJobDetails(apiKey, posting)).rejects.toThrow("Gemini request failed.");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("rejects an already canceled request without fetching", async () => {
  const fetch = jest.mocked(globalThis.fetch);
  const controller = new AbortController();
  controller.abort(new Error(apiKey));
  await expect(extractJobDetails(apiKey, posting, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
    message: "Gemini request canceled.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("hides the uncaught abort reason from the canceled fetch", async () => {
  const controller = new AbortController();
  jest.mocked(globalThis.fetch).mockImplementation(async () => {
    controller.abort(new Error(apiKey));
    throw controller.signal.reason;
  });
  await expect(extractJobDetails(apiKey, posting, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
    message: "Gemini request canceled.",
  });
});

test.each([["", posting], [apiKey, "  "]])("requires a key and posting before fetching", async (key, text) => {
  const fetch = jest.mocked(globalThis.fetch);
  await expect(extractJobDetails(key, text)).rejects.toThrow(/key|posting/i);
  expect(fetch).not.toHaveBeenCalled();
});

test("rejects oversized posting text without fetching", async () => {
  const fetch = jest.mocked(globalThis.fetch);
  await expect(extractJobDetails(apiKey, "x".repeat(8001))).rejects.toThrow(/8,000/);
  expect(fetch).not.toHaveBeenCalled();
});

test("rejects posting text that includes the supplied API key without fetching", async () => {
  const fetch = jest.mocked(globalThis.fetch);
  const error = await extractJobDetails(apiKey, posting + "x" + apiKey + "x").catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/posting/i);
  expect(String(error)).not.toContain(apiKey);
  expect(fetch).not.toHaveBeenCalled();
});

test("rejects a response that contains the supplied API key in either extracted field", async () => {
  jest.mocked(globalThis.fetch).mockResolvedValue(Response.json(candidate(
    JSON.stringify({ company: "Morrow Works", jobTitle: "Engineer " + apiKey }),
  )));
  await expect(extractJobDetails(apiKey, posting)).rejects.toThrow("Gemini returned an invalid response.");
});

test("allows an incidental substring match for a short fixture key", async () => {
  jest.mocked(globalThis.fetch).mockResolvedValue(
    Response.json(candidate('{"company":"Morrow Works","jobTitle":null}')),
  );
  await expect(extractJobDetails("row", posting)).resolves.toEqual({
    company: "Morrow Works",
    jobTitle: null,
  });
});
