import type { CreateApplicationInput } from "@/lib/applications/contract";
import {
  ApplicationIdentityCollisionError,
  ApplicationIdentityRaceError,
  createApplicationAtomically,
  type ApplicationIdentityStore,
  type StoredApplicationRow,
} from "@/lib/applications/atomic-create";

const NOW = new Date("2026-08-13T14:00:00.000Z");
const INPUT: CreateApplicationInput = Object.freeze({
  url: "https://example.test/jobs/42?utm_source=feed",
  jobTitle: "Engineer",
  company: "Example",
  status: "Applied",
  appliedDate: undefined,
  description: "Description",
  notes: "Do not mutate",
  salary: null,
  location: "Remote",
  jobType: "Remote",
});

describe("atomic application creation", () => {
  it("returns created from one insert with an application UUID and one timestamp", async () => {
    const inserted: StoredApplicationRow[] = [];
    const store = fakeStore({
      insert: async (row) => {
        inserted.push(row);
        return row;
      },
    });

    const result = await createApplicationAtomically(INPUT, {
      store,
      randomUUID: () => "018f9f72-f2e9-7c29-a6fc-001122334455",
      now: () => NOW,
    });

    expect(result).toEqual({
      result: "created",
      application: publicApplication(inserted[0]),
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      id: "018f9f72-f2e9-7c29-a6fc-001122334455",
      url: INPUT.url,
      appliedDate: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      identityState: "canonical",
      duplicateOfId: null,
    });
    expect(inserted[0].appliedDate).toBe(inserted[0].createdAt);
    expect(inserted[0].createdAt).toBe(inserted[0].updatedAt);
  });

  it("returns the existing row without mutating its fields", async () => {
    const existing = storedRow({
      status: "Interview",
      notes: "Existing notes",
      appliedDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    const store = fakeStore({ insert: async () => null, find: async () => existing });

    const result = await createApplicationAtomically(INPUT, dependencies(store));

    expect(result).toEqual({
      result: "existing",
      application: publicApplication(existing),
    });
    expect(existing.status).toBe("Interview");
    expect(existing.notes).toBe("Existing notes");
    expect(store.insertCanonical).toHaveBeenCalledTimes(1);
    expect(store.findByIdentityKey).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a digest resolves to a different canonical URL", async () => {
    const existing = storedRow({ canonicalUrl: "https://collision.test/different" });
    const store = fakeStore({ insert: async () => null, find: async () => existing });

    await expect(createApplicationAtomically(INPUT, dependencies(store))).rejects.toBeInstanceOf(
      ApplicationIdentityCollisionError,
    );
  });

  it("retries one concurrent delete race and can create on the second insert", async () => {
    let attempts = 0;
    const store = fakeStore({
      insert: async (row) => (++attempts === 1 ? null : row),
      find: async () => null,
    });

    const result = await createApplicationAtomically(INPUT, dependencies(store));

    expect(result.result).toBe("created");
    expect(store.insertCanonical).toHaveBeenCalledTimes(2);
    expect(store.findByIdentityKey).toHaveBeenCalledTimes(1);
  });

  it("fails internally after one bounded delete-race retry", async () => {
    const store = fakeStore({ insert: async () => null, find: async () => null });

    await expect(createApplicationAtomically(INPUT, dependencies(store))).rejects.toBeInstanceOf(
      ApplicationIdentityRaceError,
    );
    expect(store.insertCanonical).toHaveBeenCalledTimes(2);
    expect(store.findByIdentityKey).toHaveBeenCalledTimes(2);
  });
});

function dependencies(store: ApplicationIdentityStore) {
  let sequence = 0;
  return {
    store,
    randomUUID: () => `018f9f72-f2e9-7c29-a6fc-${String(++sequence).padStart(12, "0")}`,
    now: () => NOW,
  };
}

function fakeStore(overrides: {
  insert: (row: StoredApplicationRow) => Promise<StoredApplicationRow | null>;
  find?: (identityKey: string) => Promise<StoredApplicationRow | null>;
}): ApplicationIdentityStore & {
  insertCanonical: jest.Mock;
  findByIdentityKey: jest.Mock;
} {
  return {
    insertCanonical: jest.fn(overrides.insert),
    findByIdentityKey: jest.fn(overrides.find ?? (async () => null)),
  };
}

function storedRow(overrides: Partial<StoredApplicationRow> = {}): StoredApplicationRow {
  return {
    id: "018f9f72-f2e9-7c29-a6fc-001122334455",
    url: INPUT.url,
    jobTitle: INPUT.jobTitle,
    company: INPUT.company,
    status: INPUT.status,
    appliedDate: NOW,
    description: INPUT.description,
    notes: INPUT.notes,
    salary: INPUT.salary,
    location: INPUT.location,
    jobType: INPUT.jobType,
    createdAt: NOW,
    updatedAt: NOW,
    identityKey: "url-v1:placeholder",
    canonicalUrl: "https://example.test/jobs/42",
    duplicateOfId: null,
    identityState: "canonical",
    ...overrides,
  };
}

function publicApplication(row: StoredApplicationRow | undefined) {
  if (!row) throw new Error("missing row");
  return {
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
  };
}
