import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const supportUrl = pathToFileURL(
  join(__dirname, "../../scripts/extension-e2e-support.mjs"),
).href;
const supportRunner = `
import * as support from ${JSON.stringify(supportUrl)};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
try {
  const value = support[request.operation](...request.arguments);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
`;
const redactionRunner = `
import {
  assertSanitizedPopupSnapshot,
  redactPopupDocument,
} from ${JSON.stringify(supportUrl)};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
class FakeElement {
  constructor(source) {
    Object.assign(this, source);
    this.attributes = Object.entries(source.attributes ?? {}).map(
      ([name, value]) => ({ name, value }),
    );
    this.style = {};
    this.hidden = false;
  }
  removeAttribute(name) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
  replaceChildren() {
    this.textContent = "";
  }
}
const elements = request.elements.map((source) => new FakeElement(source));
const byId = new Map(elements.map((element) => [element.id, element]));
globalThis.document = {
  getElementById: (id) => byId.get(id) ?? null,
  querySelectorAll: (selector) => {
    if (selector === "input, textarea") {
      return elements.filter((element) =>
        element.tagName === "INPUT" || element.tagName === "TEXTAREA"
      );
    }
    return elements;
  },
  documentElement: {
    get outerHTML() {
      return JSON.stringify(elements);
    },
  },
};
try {
  const snapshot = redactPopupDocument();
  assertSanitizedPopupSnapshot(snapshot, request.sensitiveValues);
  process.stdout.write(JSON.stringify({ ok: true, snapshot }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
`;

function callSupport<T>(operation: string, ...args: unknown[]): T {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", supportRunner],
    {
      input: JSON.stringify({ operation, arguments: args }),
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `support process exited ${result.status}`);
  }
  const response = JSON.parse(result.stdout) as
    | { ok: true; value: T }
    | { ok: false; error: string };
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

const validEnvironment = Object.freeze({
  RUN_EXTENSION_E2E: "1",
  ALLOW_DESTRUCTIVE_EXTENSION_E2E: "jobtracker-extension-e2e-delete-all",
  DATABASE_URL:
    "postgresql://jobtracker:jobtracker@127.0.0.1:5432/jobtracker_extension_e2e_test",
  EXPECTED_DATABASE_SERVER_ADDRESS: "127.0.0.1",
});

describe("extension E2E safety support", () => {
  it("accepts only the explicit loopback destructive-test target", () => {
    expect(
      callSupport("assertSafeExtensionE2EEnvironment", validEnvironment),
    ).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "jobtracker_extension_e2e_test",
      serverAddress: "127.0.0.1",
    });
  });

  it.each([
    ["run sentinel", { RUN_EXTENSION_E2E: "0" }],
    ["destructive acknowledgement", { ALLOW_DESTRUCTIVE_EXTENSION_E2E: "yes" }],
    [
      "remote database",
      {
        DATABASE_URL:
          "postgresql://jobtracker:jobtracker@example.neon.tech:5432/jobtracker_extension_e2e_test",
      },
    ],
    [
      "implicit port",
      {
        DATABASE_URL:
          "postgresql://jobtracker:jobtracker@127.0.0.1/jobtracker_extension_e2e_test",
      },
    ],
    [
      "wrong database",
      {
        DATABASE_URL:
          "postgresql://jobtracker:jobtracker@127.0.0.1:5432/jobtracker_test",
      },
    ],
    [
      "ambiguous query",
      {
        DATABASE_URL:
          "postgresql://jobtracker:jobtracker@127.0.0.1:5432/jobtracker_extension_e2e_test?host=example.neon.tech",
      },
    ],
    ["missing live server address", { EXPECTED_DATABASE_SERVER_ADDRESS: "" }],
  ])("rejects an unsafe %s", (_name, override) => {
    expect(() =>
      callSupport("assertSafeExtensionE2EEnvironment", {
        ...validEnvironment,
        ...override,
      }),
    ).toThrow("Refusing destructive extension E2E");
  });

  it("adds only the exact optional loopback origin without mutating the source", () => {
    const source = {
      manifest_version: 3,
      host_permissions: ["https://*/*"],
      optional_host_permissions: [
        "https://*/*",
        "http://localhost/*",
        "http://127.0.0.1/*",
        "https://example.com/*",
      ],
    };

    const result = callSupport<{
      host_permissions: string[];
      optional_host_permissions: string[];
    }>(
      "buildE2EManifest",
      source,
      "http://127.0.0.1:3100",
      "https://jobs.lever.co/*",
    );

    expect(result.host_permissions).toEqual(["https://jobs.lever.co/*"]);
    expect(result.optional_host_permissions).toEqual([
      "http://127.0.0.1:3100/*",
    ]);
    expect(result).not.toBe(source);
    expect(source.optional_host_permissions).toContain("http://localhost/*");
  });

  it("accepts only the canonical local PostgreSQL 17 admin identity", () => {
    const target = callSupport(
      "assertSafeExtensionE2EAdminUrl",
      "postgresql://postgres@127.0.0.1:5432/postgres",
    );
    expect(target).toEqual({ host: "127.0.0.1", port: 5432 });
    expect(
      callSupport("assertLocalPostgres17Identity", {
        database: "postgres",
        address: "127.0.0.1",
        port: 5432,
        version: 170_010,
      }, target),
    ).toEqual({ address: "127.0.0.1" });

    for (const unsafeUrl of [
      "postgresql://postgres@localhost:5432/postgres",
      "postgresql://postgres@10.0.0.5:5432/postgres",
      "postgresql://postgres@127.0.0.1/postgres",
      "postgresql://postgres@127.0.0.1:5432/postgres?host=10.0.0.5",
    ]) {
      expect(() =>
        callSupport("assertSafeExtensionE2EAdminUrl", unsafeUrl),
      ).toThrow("Refusing extension E2E");
    }

    for (const address of ["10.0.0.5", "192.168.1.10", "::1", "203.0.113.4"]) {
      expect(() =>
        callSupport("assertLocalPostgres17Identity", {
          database: "postgres",
          address,
          port: 5432,
          version: 170_010,
        }, target),
      ).toThrow("live PostgreSQL 17 identity mismatch");
    }
  });

  it("derives a dynamic extension origin from an MV3 worker URL", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(
      callSupport(
        "extensionIdentityFromWorkerUrl",
        `chrome-extension://${id}/background.js`,
      ),
    ).toEqual({ id, origin: `chrome-extension://${id}` });
    expect(() =>
      callSupport(
        "extensionIdentityFromWorkerUrl",
        `https://${id}/background.js`,
      ),
    ).toThrow("Invalid extension service worker URL");
  });

  it("selects only the live MV3 registration and version for the extension", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(
      callSupport("extensionServiceWorkerStateFromCdp", {
        registrations: [
          {
            registrationId: "unrelated-registration",
            scopeURL: "https://example.com/",
            isDeleted: false,
          },
          {
            registrationId: "extension-registration",
            scopeURL: `chrome-extension://${id}/`,
            isDeleted: false,
          },
        ],
        versions: [
          {
            versionId: "extension-version",
            registrationId: "extension-registration",
            scriptURL: `chrome-extension://${id}/background.js`,
            runningStatus: "running",
            targetId: "old-target",
          },
        ],
      }, id),
    ).toEqual({
      registrationId: "extension-registration",
      scopeURL: `chrome-extension://${id}/`,
      versionId: "extension-version",
      targetId: "old-target",
      scriptURL: `chrome-extension://${id}/background.js`,
    });

    expect(() =>
      callSupport("extensionServiceWorkerStateFromCdp", {
        registrations: [],
        versions: [],
      }, id),
    ).toThrow("extension service worker CDP state was unavailable");
  });

  it("removes populated analysis and all fixture-derived values before capture", () => {
    const sensitiveValues = [
      "Senior Platform Engineer",
      "JobTracker E2E",
      "Build reliable TypeScript and PostgreSQL systems",
      "TypeScript",
      "PostgreSQL",
      "Kubernetes",
      "extension-e2e-access-token-aaaaaaaaaaaaaaaa",
    ];
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", redactionRunner],
      {
        input: JSON.stringify({
          sensitiveValues,
          elements: [
            {
              id: "accessToken",
              tagName: "INPUT",
              value: sensitiveValues[6],
              textContent: "",
              attributes: { value: sensitiveValues[6] },
            },
            {
              id: "jobTitle",
              tagName: "INPUT",
              value: sensitiveValues[0],
              textContent: "",
              attributes: { value: sensitiveValues[0] },
            },
            {
              id: "company",
              tagName: "INPUT",
              value: sensitiveValues[1],
              textContent: "",
            },
            {
              id: "description",
              tagName: "TEXTAREA",
              value: sensitiveValues[2],
              textContent: sensitiveValues[2],
            },
            {
              id: "analysisSection",
              tagName: "DIV",
              textContent: sensitiveValues.slice(3, 6).join(" "),
              attributes: { "data-keywords": sensitiveValues.slice(3, 6).join(",") },
            },
            {
              id: "matchedPills",
              tagName: "DIV",
              textContent: `${sensitiveValues[3]} ${sensitiveValues[4]}`,
            },
            {
              id: "missingPills",
              tagName: "DIV",
              textContent: sensitiveValues[5],
            },
            {
              id: "analysisSummary",
              tagName: "DIV",
              textContent: `${sensitiveValues[0]} at ${sensitiveValues[1]}`,
            },
            {
              id: "fixtureLink",
              tagName: "A",
              textContent: sensitiveValues[0],
              attributes: {
                href: "https://jobs.lever.co/jobtracker-e2e/senior-platform-engineer",
                "data-company": sensitiveValues[1],
              },
            },
          ],
        }),
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout) as
      | { ok: true; snapshot: string }
      | { ok: false; error: string };
    if (!response.ok) throw new Error(response.error);
    for (const sensitiveValue of sensitiveValues) {
      expect(response.snapshot).not.toContain(sensitiveValue);
    }
    expect(response.snapshot).not.toContain("jobs.lever.co");
    expect(response.snapshot).not.toContain("data-company");
  });

  it("accepts cleanup only for a direct runner-owned temporary workspace", () => {
    expect(
      callSupport(
        "assertExtensionE2EWorkspacePath",
        "/private/tmp/jobtracker-extension-e2e-AbC123",
        "/private/tmp",
      ),
    ).toBe("/private/tmp/jobtracker-extension-e2e-AbC123");
    for (const unsafePath of [
      "/private/tmp",
      "/private/tmp/unrelated-profile",
      "/private/tmp/nested/jobtracker-extension-e2e-AbC123",
      "/private/tmp/jobtracker-extension-e2e-../production",
    ]) {
      expect(() =>
        callSupport(
          "assertExtensionE2EWorkspacePath",
          unsafePath,
          "/private/tmp",
        ),
      ).toThrow("Refusing extension E2E workspace cleanup");
    }
  });

  it("retains the MV3 restart and generic-only screenshot runner contract", () => {
    const runner = readFileSync(
      join(__dirname, "../../scripts/extension-e2e.mjs"),
      "utf8",
    );
    for (const requiredText of [
      "ServiceWorker.enable",
      "ServiceWorker.stopWorker",
      "chrome.developerPrivate.openDevTools",
      "Target.getTargets",
      "Target.attachToTarget",
      "MV3 worker restart and connection restoration",
      "assertSanitizedPopupSnapshot",
      "popupArtifactSensitiveValues",
      "assertExtensionE2EWorkspacePath",
    ]) {
      expect(runner).toContain(requiredText);
    }
  });

  it("owns and drains the full local wrapper child process group", () => {
    const wrapper = readFileSync(
      join(__dirname, "../../scripts/extension-e2e-local.mjs"),
      "utf8",
    );
    for (const requiredText of [
      "detached: true",
      "process.kill(-child.pid",
      'child.once("close"',
      '"SIGKILL"',
      "terminateActiveChildTree",
    ]) {
      expect(wrapper).toContain(requiredText);
    }
    expect(wrapper).not.toContain("process.exit(");
  });

  it("parses only a loopback Docker host-port binding", () => {
    expect(callSupport("parseDockerPort", "127.0.0.1:49152")).toBe(49152);
    expect(() => callSupport("parseDockerPort", "0.0.0.0:49152")).toThrow(
      "Invalid loopback Docker port",
    );
    expect(() =>
      callSupport("parseDockerPort", "127.0.0.1:not-a-port"),
    ).toThrow(
      "Invalid loopback Docker port",
    );
  });
});
