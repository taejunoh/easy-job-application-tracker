import { useRef, useState } from "react";
import { CSV_FIELDS, MAX_CSV_BYTES, exportCsv, parseCsv, previewCsv, suggestMapping, type CsvMapping, type CsvPreview } from "../csv";
import type { TrackerStorage } from "./BrowserLocalApp";

export default function CsvPanel({ storage, onImported }: {
  storage: TrackerStorage;
  onImported: (count: number) => void;
}) {
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<CsvMapping>({});
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inProgress = useRef(false);

  async function run(operation: () => Promise<void>) {
    if (inProgress.current) return;
    inProgress.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not complete the CSV operation.");
    } finally {
      setBusy(false);
      inProgress.current = false;
    }
  }

  async function selectFile(file?: File) {
    setRows([]);
    setPreview(null);
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) throw new Error("Use a CSV file smaller than 4 MiB.");
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) throw new Error("Include a header row and at least one application.");
    setRows(parsed);
    setMapping(suggestMapping(parsed[0]));
  }

  async function download() {
    const records = await storage.listApplications();
    const url = URL.createObjectURL(new Blob(["\uFEFF", exportCsv(records)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "jobtracker-applications.csv";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="bl-panel bl-settings" aria-labelledby="bl-csv">
      <h2 id="bl-csv">Spreadsheet import and export</h2>
      <p>Use a CSV with a header row to add applications to this browser. Use the JSON backup above for a full backup, including résumé text.</p>
      <button type="button" className="bl-button" disabled={busy} onClick={() => void run(download)}>Download applications CSV</button>
      <label>CSV file <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        void run(() => selectFile(file));
      }} /></label>
      {rows.length > 0 && (
        <>
          <h3>Match your columns</h3>
          <p>Company and job title are required. Use YYYY-MM-DD for dates.</p>
          <div className="bl-form-grid">
            {CSV_FIELDS.map(([field, label]) => (
              <label key={field}>{label}
                <select disabled={busy} value={mapping[field] ?? ""} onChange={(event) => {
                  const value = event.currentTarget.value;
                  setMapping({ ...mapping, [field]: value === "" ? undefined : Number(value) });
                  setPreview(null);
                }}>
                  <option value="">Skip column</option>
                  {rows[0].map((header, index) => <option key={index} value={index}>{header || "Unnamed column"} ({index + 1})</option>)}
                </select>
              </label>
            ))}
          </div>
          <button type="button" className="bl-button" disabled={busy || mapping.company === undefined || mapping.jobTitle === undefined}
            onClick={() => void run(async () => setPreview(previewCsv(rows, mapping, await storage.listApplications())))}>
            Preview CSV
          </button>
        </>
      )}
      {preview && (
        <div className="bl-confirm">
          <h3>Import preview</h3>
          <p>{preview.entries.length} ready to add · {preview.rejected.length} skipped</p>
          {preview.entries.length > 0 && <ul>{preview.entries.slice(0, 5).map((entry, index) =>
            <li key={index}>{entry.company} — {entry.jobTitle}</li>)}</ul>}
          {preview.rejected.length > 0 && <details><summary>Why rows were skipped</summary><ul>
            {preview.rejected.map(({ row, reason }) => <li key={row}>Record {row}: {reason}</li>)}
          </ul></details>}
          <button type="button" className="bl-button bl-primary" disabled={busy || !preview.entries.length}
            onClick={() => void run(async () => {
              const count = await storage.importApplications(preview.entries);
              setRows([]);
              setPreview(null);
              onImported(count);
            })}>Add {preview.entries.length} applications</button>
        </div>
      )}
      {error && <p role="alert" className="bl-error">{error}</p>}
    </section>
  );
}
