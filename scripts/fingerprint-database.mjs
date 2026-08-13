import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function fingerprintableTables(client) {
  const result = await client.query(`
    SELECT
      tables.table_name AS "tableName",
      array_agg(columns.column_name ORDER BY columns.ordinal_position)::text[] AS "columns",
      COALESCE(
        array_agg(primary_columns.column_name ORDER BY primary_columns.ordinal_position)
          FILTER (WHERE primary_columns.column_name IS NOT NULL),
        ARRAY[]::text[]
      )::text[] AS "primaryKey"
    FROM information_schema.tables AS tables
    JOIN information_schema.columns AS columns
      ON columns.table_schema = tables.table_schema
     AND columns.table_name = tables.table_name
    LEFT JOIN (
      SELECT
        constraints.table_schema,
        constraints.table_name,
        key_usage.column_name,
        key_usage.ordinal_position
      FROM information_schema.table_constraints AS constraints
      JOIN information_schema.key_column_usage AS key_usage
        ON key_usage.constraint_schema = constraints.constraint_schema
       AND key_usage.constraint_name = constraints.constraint_name
       AND key_usage.table_schema = constraints.table_schema
       AND key_usage.table_name = constraints.table_name
      WHERE constraints.constraint_type = 'PRIMARY KEY'
    ) AS primary_columns
      ON primary_columns.table_schema = tables.table_schema
     AND primary_columns.table_name = tables.table_name
     AND primary_columns.column_name = columns.column_name
    WHERE tables.table_schema = 'public'
      AND tables.table_type = 'BASE TABLE'
    GROUP BY tables.table_name
    ORDER BY tables.table_name COLLATE "C"
  `);
  return result.rows;
}

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
  const definitions = await fingerprintableTables(client);
  for (const definition of definitions) {
    if (!Array.isArray(definition.columns) || definition.columns.length === 0) {
      throw new Error("Database fingerprint failed");
    }
    if (!Array.isArray(definition.primaryKey) || definition.primaryKey.length === 0) {
      throw new Error("Database fingerprint requires a primary key");
    }
    const columns = definition.columns.map(quoteIdentifier).join(", ");
    const primaryKey = definition.primaryKey.map(quoteIdentifier).join(", ");
    const order = `jsonb_build_array(${primaryKey})::text COLLATE "C"`;
    const result = await client.query(
      `SELECT ${columns} FROM ${quoteIdentifier(definition.tableName)} ORDER BY ${order}`,
    );
    tables[definition.tableName] = {
      count: result.rows.length,
      digest: digestRows(definition.tableName, result.rows),
    };
  }
  return { version: 2, algorithm: "sha256", tables };
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
