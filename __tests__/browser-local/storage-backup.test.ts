import { createLocalTrackerStorage, MAX_BACKUP_BYTES, previewBackup } from "../../src/browser-local/storage";

const application = {
  id: "test-application",
  url: "https://example.com/jobs/42",
  jobTitle: "Engineer",
  company: "Example",
  status: "Applied",
  appliedDate: "2026-11-13T00:00:00.000Z",
  description: null,
  notes: null,
  salary: null,
  location: null,
  jobType: null,
  nextStep: null,
  nextStepDate: null,
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  identityKey: null,
  canonicalUrl: null,
  duplicateOfId: null,
  identityState: "legacy_unresolved",
};

const backup = {
  schemaVersion: 1,
  exportedAt: "2026-11-13T00:00:00.000Z",
  applications: [application],
  settings: { linkedinUrl: "", githubUrl: "", resumeText: "Work history" },
};

test("previews a valid backup without IndexedDB access", () => {
  const preview = previewBackup(JSON.stringify(backup));
  expect(preview).toEqual({
    applicationCount: 1,
    hasResume: true,
    exportedAt: backup.exportedAt,
  });
  expect(Object.isFrozen(preview)).toBe(true);
});

test("preserves independently tracked applications with the same URL", () => {
  expect(previewBackup(JSON.stringify({
    ...backup,
    applications: [application, { ...application, id: "another-application" }],
  })).applicationCount).toBe(2);
});

test.each([
  ["unsupported version", { ...backup, schemaVersion: 2 }],
  ["invalid application field", { ...backup, applications: [{ ...application, notes: 123 }] }],
  ["invalid calendar date", { ...backup, applications: [{ ...application, nextStepDate: "2026-02-30" }] }],
  ["duplicate IDs", { ...backup, applications: [application, application] }],
  ["extra application field", { ...backup, applications: [{ ...application, authorization: "value" }] }],
  ["credential setting", { ...backup, settings: { ...backup.settings, apiKey: "value" } }],
  ["credential URL", { ...backup, applications: [{ ...application, url: "https://user:password@example.com/" }] }],
  ["token query string", { ...backup, applications: [{ ...application, url: "https://example.com/?access_token=value" }] }],
  ["unsafe URL scheme", { ...backup, applications: [{ ...application, url: "javascript:alert(1)" }] }],
])("rejects backups with %s", (_reason, payload) => {
  expect(() => previewBackup(JSON.stringify(payload))).toThrow();
});

test("rejects a forged restore confirmation before opening IndexedDB", async () => {
  await expect(createLocalTrackerStorage().restoreBackup({
    applicationCount: 1,
    hasResume: true,
    exportedAt: backup.exportedAt,
  })).rejects.toThrow("Preview a valid backup before restoring");
});

test("preserves legacy status and job type values during backup validation", () => {
  expect(previewBackup(JSON.stringify({
    ...backup,
    applications: [{ ...application, status: "Legacy status", jobType: "Legacy type" }],
  })).applicationCount).toBe(1);
});

test("rejects an import that would exceed the backup limit after date normalization", () => {
  const description = "\0".repeat(100_000);
  const applications = Array.from({ length: 55 }, (_, index) => ({
    ...application,
    id: String(index),
    appliedDate: "2026-11-13",
    description,
  }));
  const settings = { ...backup.settings, resumeText: "" };
  const payload = { ...backup, applications, settings };
  settings.resumeText = "a".repeat(MAX_BACKUP_BYTES - JSON.stringify(payload).length);
  const json = JSON.stringify(payload);
  expect(json.length).toBe(MAX_BACKUP_BYTES);
  expect(() => previewBackup(json)).toThrow("32 MB limit");
});

test("rejects unsupported statuses in new applications before opening IndexedDB", async () => {
  await expect(createLocalTrackerStorage().createApplication({
    url: application.url,
    jobTitle: application.jobTitle,
    company: application.company,
    status: "Legacy status",
  })).rejects.toThrow("Invalid status");
});
