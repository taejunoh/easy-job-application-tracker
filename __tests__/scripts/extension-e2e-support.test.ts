import { spawnSync } from "node:child_process";
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
      optional_host_permissions: [
        "https://*/*",
        "http://localhost/*",
        "http://127.0.0.1/*",
      ],
    };

    const result = callSupport<{
      optional_host_permissions: string[];
    }>("buildE2EManifest", source, "http://127.0.0.1:3100");

    expect(result.optional_host_permissions).toEqual([
      "https://*/*",
      "http://127.0.0.1:3100/*",
    ]);
    expect(result).not.toBe(source);
    expect(source.optional_host_permissions).toContain("http://localhost/*");
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
