import { Prisma } from "@prisma/client";

import type {
  ApplicationIdentityStore,
  StoredApplicationRow,
} from "./atomic-create.ts";

type PrismaIdentityClient = Readonly<{
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  application: Readonly<{
    findUnique(args: Readonly<{ where: Readonly<{ identityKey: string }> }>): Promise<unknown>;
  }>;
}>;

export function createPrismaApplicationIdentityStore(
  client: PrismaIdentityClient,
): ApplicationIdentityStore {
  return Object.freeze({
    async insertCanonical(row: StoredApplicationRow): Promise<StoredApplicationRow | null> {
      const rows = await client.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO "Application" (
          "id",
          "url",
          "jobTitle",
          "company",
          "status",
          "appliedDate",
          "description",
          "notes",
          "salary",
          "location",
          "jobType",
          "createdAt",
          "updatedAt",
          "identityKey",
          "canonicalUrl",
          "duplicateOfId",
          "identityState"
        ) VALUES (
          ${row.id},
          ${row.url},
          ${row.jobTitle},
          ${row.company},
          ${row.status},
          ${row.appliedDate},
          ${row.description},
          ${row.notes},
          ${row.salary},
          ${row.location},
          ${row.jobType},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.identityKey},
          ${row.canonicalUrl},
          ${row.duplicateOfId},
          ${row.identityState}
        )
        ON CONFLICT ("identityKey") DO NOTHING
        RETURNING
          "id",
          "url",
          "jobTitle",
          "company",
          "status",
          "appliedDate",
          "description",
          "notes",
          "salary",
          "location",
          "jobType",
          "createdAt",
          "updatedAt",
          "identityKey",
          "canonicalUrl",
          "duplicateOfId",
          "identityState"
      `);
      return rows.length === 0 ? null : toStoredCanonicalRow(rows[0]);
    },

    async findByIdentityKey(identityKey: string): Promise<StoredApplicationRow | null> {
      const row = await client.application.findUnique({ where: { identityKey } });
      return row === null ? null : toStoredCanonicalRow(row);
    },
  });
}

function toStoredCanonicalRow(value: unknown): StoredApplicationRow {
  if (value === null || typeof value !== "object") invalidRow();
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.url !== "string" ||
    typeof row.jobTitle !== "string" ||
    typeof row.company !== "string" ||
    typeof row.status !== "string" ||
    !(row.appliedDate instanceof Date) ||
    !nullableString(row.description) ||
    !nullableString(row.notes) ||
    !nullableString(row.salary) ||
    !nullableString(row.location) ||
    !nullableString(row.jobType) ||
    !(row.createdAt instanceof Date) ||
    !(row.updatedAt instanceof Date) ||
    typeof row.identityKey !== "string" ||
    typeof row.canonicalUrl !== "string" ||
    row.duplicateOfId !== null ||
    row.identityState !== "canonical"
  ) {
    invalidRow();
  }

  return Object.freeze({
    id: row.id,
    url: row.url,
    jobTitle: row.jobTitle,
    company: row.company,
    status: row.status,
    appliedDate: row.appliedDate,
    description: row.description,
    notes: row.notes,
    salary: row.salary,
    location: row.location,
    jobType: row.jobType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    identityKey: row.identityKey,
    canonicalUrl: row.canonicalUrl,
    duplicateOfId: null,
    identityState: "canonical",
  });
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function invalidRow(): never {
  throw new Error("Invalid Application row returned by database");
}
