import type { DatabaseTestIdentity } from "./database-test-guard";

export type { DatabaseTestIdentity } from "./database-test-guard";

export type LiveDatabaseIdentity = Readonly<{
  database: string;
  address: string;
  port: number;
  schema: "public";
}>;

type IntegrationDatabase = Readonly<{
  $queryRawUnsafe(query: string): Promise<unknown>;
  application: Readonly<{ deleteMany(): Promise<unknown> }>;
  settings: Readonly<{ deleteMany(): Promise<unknown> }>;
}>;

const IDENTITY_QUERY =
  "SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, current_schema() AS schema";

export async function verifyLiveDatabaseIdentity(
  database: Pick<IntegrationDatabase, "$queryRawUnsafe">,
  expected: DatabaseTestIdentity,
): Promise<LiveDatabaseIdentity> {
  const result = await database.$queryRawUnsafe(IDENTITY_QUERY);
  if (!Array.isArray(result) || result.length !== 1) mismatch();

  const row = result[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) mismatch();
  const value = row as Record<string, unknown>;
  if (
    value.database !== expected.database ||
    value.address !== expected.serverAddress ||
    value.port !== expected.port ||
    value.schema !== "public"
  ) {
    mismatch();
  }

  return Object.freeze({
    database: value.database as string,
    address: value.address as string,
    port: value.port as number,
    schema: "public" as const,
  });
}

export async function resetVerifiedIntegrationDatabase(
  database: IntegrationDatabase,
  expected: DatabaseTestIdentity,
): Promise<LiveDatabaseIdentity> {
  const identity = await verifyLiveDatabaseIdentity(database, expected);
  await database.application.deleteMany();
  await database.settings.deleteMany();
  return identity;
}

function mismatch(): never {
  throw new Error(
    "Live database identity does not match destructive-test target",
  );
}
