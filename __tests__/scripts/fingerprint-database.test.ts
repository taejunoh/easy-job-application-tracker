import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fingerprintUrl = pathToFileURL(
  join(__dirname, "../../scripts/fingerprint-database.mjs"),
).href;

describe("database fingerprint table discovery", () => {
  it("dynamically fingerprints both extension credential tables", () => {
    const runner = `
      import { fingerprintClient } from ${JSON.stringify(fingerprintUrl)};
      const definitions = [
        { tableName: "ExtensionInstallation", columns: ["id", "origin"], primaryKey: ["id"] },
        { tableName: "ExtensionPairingGrant", columns: ["id", "origin"], primaryKey: ["id"] },
      ];
      const calls = [];
      const client = {
        async query(sql) {
          calls.push(sql);
          if (calls.length === 1) return { rows: definitions };
          if (sql.includes('"ExtensionInstallation"')) {
            return { rows: [{ id: "installation-a", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] };
          }
          if (sql.includes('"ExtensionPairingGrant"')) {
            return { rows: [{ id: "grant-a", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] };
          }
          throw new Error("unexpected table query");
        },
      };
      const result = await fingerprintClient(client);
      process.stdout.write(JSON.stringify({ result, calls }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", runner],
      { encoding: "utf8" },
    );

    expect(child.status).toBe(0);
    const output = JSON.parse(child.stdout) as {
      result: {
        version: number;
        tables: Record<string, { count: number; digest: string }>;
      };
      calls: string[];
    };
    expect(output.result.version).toBe(2);
    expect(Object.keys(output.result.tables)).toEqual([
      "ExtensionInstallation",
      "ExtensionPairingGrant",
    ]);
    for (const table of Object.values(output.result.tables)) {
      expect(table.count).toBe(1);
      expect(table.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(output.calls[0]).toContain("information_schema.tables");
    expect(output.calls[0]).toContain("tables.table_type = 'BASE TABLE'");
  });
});
