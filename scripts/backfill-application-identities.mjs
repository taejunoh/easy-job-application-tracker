import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  buildApplicationIdentityPlan,
  createPrivacySafeReport,
  parseBackfillArguments,
  writeBackfillReport,
} from "../src/lib/applications/backfill.ts";

const { Client } = pg;

export async function backfillApplicationIdentities({
  client,
  apply,
  reportPath,
}) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    if (apply) {
      await client.query('LOCK TABLE "Application" IN ACCESS EXCLUSIVE MODE');
    }
    const source = await client.query(
      'SELECT "id", "url", "createdAt" FROM "Application" ORDER BY "createdAt" ASC, "id" ASC',
    );
    const plan = buildApplicationIdentityPlan(source.rows);
    const rowCountBefore = source.rows.length;
    const uniqueIndexVerified = await verifyUniqueIndex(client);
    if (!uniqueIndexVerified) throw new Error("Identity index verification failed");

    if (apply) {
      await client.query(`
        UPDATE "Application"
        SET
          "identityKey" = NULL,
          "canonicalUrl" = NULL,
          "duplicateOfId" = NULL,
          "identityState" = 'legacy_unresolved'
      `);
      for (const assignment of plan) {
        const result = await client.query(
          `
            UPDATE "Application"
            SET
              "identityKey" = $2,
              "canonicalUrl" = $3,
              "duplicateOfId" = $4,
              "identityState" = $5
            WHERE "id" = $1
          `,
          [
            assignment.id,
            assignment.identityKey,
            assignment.canonicalUrl,
            assignment.duplicateOfId,
            assignment.state,
          ],
        );
        if (result.rowCount !== 1) throw new Error("Backfill row changed unexpectedly");
      }
    }

    const countResult = await client.query('SELECT COUNT(*)::int AS "count" FROM "Application"');
    const rowCountAfter = countResult.rows[0]?.count;
    if (rowCountAfter !== rowCountBefore) throw new Error("Application row count changed");

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    const report = createPrivacySafeReport({
      mode: apply ? "apply" : "dry-run",
      rowCountBefore,
      rowCountAfter,
      uniqueIndexVerified,
      plan,
    });
    await writeBackfillReport(reportPath, report);
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function verifyUniqueIndex(client) {
  const result = await client.query(`
    SELECT index_record.indisunique, index_record.indisvalid
    FROM pg_catalog.pg_class AS table_record
    JOIN pg_catalog.pg_namespace AS namespace_record
      ON namespace_record.oid = table_record.relnamespace
    JOIN pg_catalog.pg_index AS index_record
      ON index_record.indrelid = table_record.oid
    JOIN pg_catalog.pg_class AS index_name_record
      ON index_name_record.oid = index_record.indexrelid
    WHERE namespace_record.nspname = 'public'
      AND table_record.relname = 'Application'
      AND index_name_record.relname = 'Application_identityKey_key'
  `);
  return result.rows.length === 1
    && result.rows[0].indisunique === true
    && result.rows[0].indisvalid === true;
}

async function main() {
  const options = parseBackfillArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing database configuration");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const report = await backfillApplicationIdentities({ client, ...options });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: report.schemaVersion,
      mode: report.mode,
      rowCountBefore: report.rowCountBefore,
      rowCountAfter: report.rowCountAfter,
      stateTotals: report.stateTotals,
      uniqueIndexVerified: report.uniqueIndexVerified,
    })}\n`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Application identity backfill failed.");
    process.exitCode = 1;
  });
}
