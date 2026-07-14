import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

const TABLES = [
  {
    name: "Application",
    query: `
      SELECT "id", "url", "jobTitle", "company", "status", "appliedDate",
             "description", "notes", "salary", "location", "jobType",
             "createdAt", "updatedAt"
      FROM "Application"
      ORDER BY "id" COLLATE "C"
    `,
  },
  {
    name: "Settings",
    query: `
      SELECT "id", "llmProvider", "apiKey", "linkedinUrl", "githubUrl",
             "resumeText"
      FROM "Settings"
      ORDER BY "id" COLLATE "C"
    `,
  },
  {
    name: "_prisma_migrations",
    query: `
      SELECT "id", "checksum", "finished_at", "migration_name", "logs",
             "rolled_back_at", "started_at", "applied_steps_count"
      FROM "_prisma_migrations"
      ORDER BY "id" COLLATE "C"
    `,
  },
];

function digestRows(tableName, rows) {
  const hash = createHash("sha256");
  hash.update("jobtracker-database-fingerprint-v1\0");
  hash.update(tableName);
  hash.update("\0");
  for (const row of rows) {
    const canonicalRow = JSON.stringify(row);
    hash.update(String(Buffer.byteLength(canonicalRow)));
    hash.update(":");
    hash.update(canonicalRow);
  }
  return hash.digest("hex");
}

export async function fingerprintClient(client) {
  const tables = {};
  for (const table of TABLES) {
    const result = await client.query(table.query);
    tables[table.name] = {
      count: result.rows.length,
      digest: digestRows(table.name, result.rows),
    };
  }
  return { version: 1, algorithm: "sha256", tables };
}

export async function writeFingerprint(outputPath, fingerprint) {
  await writeFile(outputPath, `${JSON.stringify(fingerprint, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function fingerprintDatabase(databaseUrl) {
  const client = new Client(databaseUrl ? { connectionString: databaseUrl } : {});
  await client.connect();
  try {
    await client.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return await fingerprintClient(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const outputPath = process.argv[2];
  if ((!databaseUrl && !process.env.PGDATABASE) || !outputPath) {
    throw new Error("Missing fingerprint input");
  }
  const fingerprint = await fingerprintDatabase(databaseUrl);
  await writeFingerprint(outputPath, fingerprint);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    console.error("Database fingerprint failed.");
    process.exitCode = 1;
  }
}
