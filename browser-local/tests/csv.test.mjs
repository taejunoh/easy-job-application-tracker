import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" });
const { parseCsv, suggestMapping, previewCsv, exportCsv } = await vite.ssrLoadModule("../src/browser-local/csv.ts");
const { createLocalTrackerStorage } = await vite.ssrLoadModule("../src/browser-local/storage/index.ts");
after(() => vite.close());

test("previews a mapped spreadsheet, preserving quoted text and reporting skipped records", () => {
  const rows = parseCsv('\uFEFFRole,Employer,Link,Notes\r\nEngineer,Acme,https://example.com/1,"Hello, ""there""\nAgain"\r\nEngineer,Acme,https://example.com/1/\r\n,Acme,\r\nDesigner,Studio,https://user:pass@example.test/');
  const preview = previewCsv(rows, suggestMapping(rows[0]), []);
  assert.equal(preview.entries.length, 1);
  assert.equal(preview.entries[0].notes, 'Hello, "there"\nAgain');
  assert.equal(preview.entries[0].status, "Saved");
  assert.deepEqual(preview.rejected.map(({ row }) => row), [3, 4, 5]);
  assert.throws(() => parseCsv('Company,Title\n"unfinished'), /unclosed/);
});

test("adds records atomically and rechecks duplicate identities in the storage transaction", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  const storage = createLocalTrackerStorage();
  const job = { company: "Acme", jobTitle: "Tester", url: "https://example.com/job", status: "Saved", appliedDate: null };
  const future = { company: "Future", jobTitle: "Designer", url: "", status: "Saved", appliedDate: null };
  const rows = parseCsv(exportCsv([job, future]));
  const preview = previewCsv(rows, suggestMapping(rows[0]), []);
  assert.equal(preview.entries.length, 2);
  assert.deepEqual(await storage.listApplications(), []);
  await storage.createApplication(job);
  assert.equal(await storage.importApplications(preview.entries), 1);
  assert.deepEqual((await storage.listApplications()).map(({ company }) => company).sort(), ["Acme", "Future"]);
  await assert.rejects(storage.importApplications([{ ...future, company: "Another" }, { ...job, company: "" }]));
  assert.equal((await storage.listApplications()).length, 2);
});

test("quotes and neutralizes formula cells when exporting", () => {
  const rows = parseCsv(exportCsv([{ company: '=SUM(1,2)', jobTitle: 'Research "Lead"', url: "" }]));
  assert.equal(rows[1][0], "'=SUM(1,2)");
  assert.equal(rows[1][1], 'Research "Lead"');
});

test("matches the company and title when either record lacks a URL", () => {
  const rows = parseCsv("Company,Job title,Posting URL\nACME,Engineer,https://example.com/new");
  const existing = [{ company: "Acme", jobTitle: "Engineer", url: "" }];
  assert.deepEqual(previewCsv(rows, suggestMapping(rows[0]), existing).rejected, [{ row: 2, reason: "Duplicate record." }]);
});
