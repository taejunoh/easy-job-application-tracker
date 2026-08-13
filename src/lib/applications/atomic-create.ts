import { randomUUID } from "node:crypto";

import type { CreateApplicationInput } from "./contract";
import { canonicalizeApplicationUrl } from "./identity.ts";

export type StoredApplicationRow = Readonly<{
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: Date;
  description: string | null;
  notes: string | null;
  salary: string | null;
  location: string | null;
  jobType: string | null;
  createdAt: Date;
  updatedAt: Date;
  identityKey: string;
  canonicalUrl: string;
  duplicateOfId: null;
  identityState: "canonical";
}>;

export type ApplicationDto = Readonly<Omit<
  StoredApplicationRow,
  "identityKey" | "canonicalUrl" | "duplicateOfId" | "identityState"
>>;

export interface ApplicationIdentityStore {
  insertCanonical(row: StoredApplicationRow): Promise<StoredApplicationRow | null>;
  findByIdentityKey(identityKey: string): Promise<StoredApplicationRow | null>;
}

export type AtomicCreateResult = Readonly<{
  result: "created" | "existing";
  application: ApplicationDto;
}>;

type Dependencies = Readonly<{
  store: ApplicationIdentityStore;
  randomUUID?: () => string;
  now?: () => Date;
}>;

export class ApplicationIdentityCollisionError extends Error {
  constructor() {
    super("Application identity collision");
    this.name = "ApplicationIdentityCollisionError";
  }
}

export class ApplicationIdentityRaceError extends Error {
  constructor() {
    super("Application identity conflict row disappeared");
    this.name = "ApplicationIdentityRaceError";
  }
}

export async function createApplicationAtomically(
  input: CreateApplicationInput,
  dependencies: Dependencies,
): Promise<AtomicCreateResult> {
  const identity = canonicalizeApplicationUrl(input.url);
  const createId = dependencies.randomUUID ?? randomUUID;
  const now = (dependencies.now ?? (() => new Date()))();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row: StoredApplicationRow = Object.freeze({
      id: createId(),
      url: input.url,
      jobTitle: input.jobTitle,
      company: input.company,
      status: input.status,
      appliedDate: input.appliedDate ?? now,
      description: input.description,
      notes: input.notes,
      salary: input.salary,
      location: input.location,
      jobType: input.jobType,
      createdAt: now,
      updatedAt: now,
      identityKey: identity.identityKey,
      canonicalUrl: identity.canonicalUrl,
      duplicateOfId: null,
      identityState: "canonical",
    });
    const inserted = await dependencies.store.insertCanonical(row);
    if (inserted) {
      return Object.freeze({ result: "created", application: toApplicationDto(inserted) });
    }

    const existing = await dependencies.store.findByIdentityKey(identity.identityKey);
    if (existing) {
      if (existing.canonicalUrl !== identity.canonicalUrl) {
        throw new ApplicationIdentityCollisionError();
      }
      return Object.freeze({ result: "existing", application: toApplicationDto(existing) });
    }
  }

  throw new ApplicationIdentityRaceError();
}

export function toApplicationDto(row: StoredApplicationRow): ApplicationDto {
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
  });
}
