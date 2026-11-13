import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: "custom",
});
const { createLocalTrackerStorage, DuplicateJobUrlError, LocalBackupCapacityError, LocalDataChangedError, MAX_BACKUP_BYTES } =
  await vite.ssrLoadModule("../src/browser-local/storage/index.ts");

after(() => vite.close());
beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
});

const job = { url: "https://example.com/jobs/42", jobTitle: "Engineer", company: "Example" };
const settings = { linkedinUrl: "", githubUrl: "", resumeText: "Example résumé" };

test("persists applications, date edits, and settings across storage instances", async () => {
  const storage = createLocalTrackerStorage();
  const created = await storage.createApplication({ ...job, appliedDate: "2026-11-13" });
  assert.equal(created.appliedDate, "2026-11-13T00:00:00.000Z");
  const updated = await storage.updateApplication(created.id, { notes: "Follow up" }, created.updatedAt);
  await storage.saveSettings(settings);

  const reopened = createLocalTrackerStorage();
  assert.deepEqual(await reopened.listApplications(), [updated]);
  assert.deepEqual(await reopened.getSettings(), settings);
  await reopened.deleteApplication(updated.id, updated.updatedAt);
  assert.deepEqual(await storage.listApplications(), []);
});

test("rejects concurrent duplicate URLs and stale application and settings writes", async () => {
  const first = createLocalTrackerStorage();
  const second = createLocalTrackerStorage();
  const results = await Promise.allSettled([
    first.createApplication(job),
    second.createApplication({ ...job, url: job.url + "/?utm_source=example" }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.ok(results.find(({ status }) => status === "rejected").reason instanceof DuplicateJobUrlError);

  const [created] = await first.listApplications();
  const initialSettings = await first.getSettings();
  const updated = await second.updateApplication(created.id, { status: "Offer" }, created.updatedAt);
  await second.saveSettings(settings, initialSettings);
  await assert.rejects(first.updateApplication(created.id, { status: "Interview" }, created.updatedAt), LocalDataChangedError);
  await assert.rejects(first.deleteApplication(created.id, created.updatedAt), LocalDataChangedError);
  await assert.rejects(first.saveSettings({ ...settings, resumeText: "stale" }, initialSettings), LocalDataChangedError);
  assert.deepEqual(await first.listApplications(), [updated]);
  assert.deepEqual(await first.getSettings(), settings);
});

test("previews without writes and atomically replaces applications and settings only after confirmation", async () => {
  const first = createLocalTrackerStorage();
  const second = createLocalTrackerStorage();
  const original = await first.createApplication(job);
  await first.saveSettings(settings);
  const backup = await first.exportBackup();
  const stalePreview = await first.previewBackup(backup);

  await second.deleteApplication(original.id, original.updatedAt);
  const replacement = await second.createApplication({ ...job, url: job.url + "/replacement" });
  const newSettings = { ...settings, resumeText: "Updated résumé" };
  await second.saveSettings(newSettings, settings);
  await assert.rejects(first.restoreBackup(stalePreview), LocalDataChangedError);

  const preview = await first.previewBackup(backup);
  assert.deepEqual(await first.listApplications(), [replacement]);
  assert.deepEqual(await first.getSettings(), newSettings);
  await first.restoreBackup(preview);
  assert.deepEqual(await second.listApplications(), [original]);
  assert.deepEqual(await second.getSettings(), settings);
  await assert.rejects(first.restoreBackup(preview), /Preview a valid backup/);
});

test("rolls back pending application replacement when writing restored settings fails", async (context) => {
  const storage = createLocalTrackerStorage();
  const original = await storage.createApplication(job);
  const backup = await storage.exportBackup();
  const changed = await storage.updateApplication(original.id, { notes: "Keep this edit" }, original.updatedAt);
  await storage.saveSettings(settings);
  const preview = await storage.previewBackup(backup);

  const put = context.mock.method(IDBObjectStore.prototype, "put", () => {
    throw new Error("Synthetic IndexedDB write failure");
  });
  await assert.rejects(storage.restoreBackup(preview), /Synthetic IndexedDB write failure/);
  put.mock.restore();
  assert.deepEqual(await storage.listApplications(), [changed]);
  assert.deepEqual(await storage.getSettings(), settings);

  await storage.restoreBackup(preview);
  assert.deepEqual(await storage.listApplications(), [original]);
  assert.equal((await storage.getSettings()).resumeText, "");
});

test("rolls back a settings write that would make existing data exceed the backup limit", async () => {
  const storage = createLocalTrackerStorage();
  const original = await storage.createApplication(job);
  const backup = JSON.parse(await storage.exportBackup());
  const description = "\0".repeat(100_000);
  backup.applications = Array.from({ length: 55 }, (_, index) => ({
    ...original, id: String(index), url: job.url + "/" + index, description,
  }));
  const json = JSON.stringify(backup);
  const available = MAX_BACKUP_BYTES - new Blob([json]).size;
  assert.ok(available > 0 && available < 1_000_000);
  await storage.restoreBackup(await storage.previewBackup(json));

  const maximum = { ...settings, resumeText: "a".repeat(available) };
  await storage.saveSettings(maximum);
  const largest = await storage.exportBackup();
  assert.equal(new Blob([largest]).size, MAX_BACKUP_BYTES);
  await assert.rejects(storage.saveSettings({ ...maximum, resumeText: maximum.resumeText + "é" }), LocalBackupCapacityError);
  assert.deepEqual(await storage.getSettings(), maximum);
  assert.equal((await storage.previewBackup(largest)).applicationCount, 55);
});
