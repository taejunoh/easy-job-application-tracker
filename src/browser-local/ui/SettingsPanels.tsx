import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { readResumeFile, RESUME_FILE_ACCEPT } from "../../../browser-local/resume-file.mjs";
import { MAX_BACKUP_BYTES, LocalBackupCapacityError, LocalDataChangedError, type LocalSettings } from "../storage";
import type { TrackerStorage } from "./BrowserLocalApp";

const RESUME_MAX_LENGTH = 1_000_000;

export function ResumePanel({ settings, onSave }: { settings: LocalSettings; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(settings.resumeText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function importResume(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const imported = await readResumeFile(file);
      if (Array.from(imported).length > RESUME_MAX_LENGTH) {
        setError("The résumé text is too long. Use a file up to 1,000,000 characters.");
      } else {
        setText(imported);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not read the résumé file.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (Array.from(text).length > RESUME_MAX_LENGTH) {
      setError("Use up to 1,000,000 characters.");
      return;
    }
    setBusy(true);
    try {
      await onSave(text);
    } catch (failure) {
      if (failure instanceof LocalDataChangedError) {
        setError("The saved résumé changed in another tab. Copy your edits before reloading the tracker.");
      } else if (failure instanceof LocalBackupCapacityError) {
        setError("This save would exceed the 32 MiB backup limit. Shorten the résumé text and try again. Your text is still in this form.");
      } else {
        setError("Could not save the résumé. Your text is still in this form.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bl-panel bl-settings" aria-labelledby="bl-resume">
      <h2 id="bl-resume">Résumé text</h2>
      <form onSubmit={save}>
        <label>
          <span className="bl-visually-hidden">Résumé text</span>
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={13}
            disabled={busy} placeholder="Paste your résumé text here." />
        </label>
        <div className="bl-resume-file">
          <label>Import PDF or TXT <input type="file" accept={RESUME_FILE_ACCEPT} disabled={busy} onChange={importResume} /></label>
          <p className="bl-muted">Review the imported text, then save it. Importing replaces the text in this form.</p>
        </div>
        {error && <p className="bl-error" role="alert">{error}</p>}
        <button className="bl-button bl-primary" type="submit" disabled={busy}>{busy ? "Working…" : "Save résumé"}</button>
      </form>
    </section>
  );
}

export function BackupPanel({ storage, onRestore }: { storage: TrackerStorage; onRestore: () => void }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<TrackerStorage["previewBackup"]>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const previewRequest = useRef(0);

  useEffect(() => () => { previewRequest.current += 1; }, []);

  async function download() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const json = await storage.exportBackup();
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      link.href = url;
      link.download = `easy-job-tracker-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Backup download started.");
    } catch {
      setError("Could not export the backup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function selectBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setPreview(null);
    setError("");
    setMessage("");
    const request = ++previewRequest.current;
    if (!file || file.size > MAX_BACKUP_BYTES) {
      if (file) setError("This file exceeds the supported backup size.");
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const next = await storage.previewBackup(await file.text());
      if (request === previewRequest.current) setPreview(next);
    } catch {
      if (request === previewRequest.current) setError("This file could not be read as a JobTracker backup.");
    } finally {
      if (request === previewRequest.current) setBusy(false);
    }
  }

  async function restore() {
    if (!preview) return;
    setError("");
    setBusy(true);
    try {
      await storage.restoreBackup(preview);
      onRestore();
    } catch (failure) {
      if (failure instanceof LocalDataChangedError) {
        setPreview(null);
        setError("Tracker data changed after you opened this backup. Select the file again to review and restore it.");
      } else {
        setError("Could not restore the backup. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bl-panel bl-settings" aria-label="Backup and restore">
      <section aria-labelledby="bl-export">
        <h2 id="bl-export">Export backup</h2>
        <p>Backups contain your application records, notes, and résumé text in a readable JSON file. Keep it somewhere private.</p>
        <button className="bl-button bl-primary" type="button" disabled={busy} onClick={download}>Download backup</button>
      </section>
      <section aria-labelledby="bl-restore">
        <h2 id="bl-restore">Restore from a backup</h2>
        <p>Restoring replaces all application records and résumé text in this browser. Download a current backup first if you want to keep them.</p>
        <label>Backup file <input ref={input} type="file" accept="application/json,.json" disabled={busy} onChange={selectBackup} /></label>
        {preview && (
          <div className="bl-confirm" role="group" aria-label="Restore confirmation">
            <h3>Backup preview</h3>
            <p role="status">{preview.applicationCount} {preview.applicationCount === 1 ? "application" : "applications"} · {preview.hasResume ? "Includes résumé text" : "No résumé text"}</p>
            <p>Exported {new Date(preview.exportedAt).toLocaleString()}</p>
            <div className="bl-actions">
              <button type="button" className="bl-button" disabled={busy} onClick={() => { setPreview(null); setError(""); input.current?.focus(); }}>Cancel restore</button>
              <button type="button" className="bl-button bl-danger" disabled={busy} onClick={restore}>{busy ? "Restoring…" : "Replace data and restore"}</button>
            </div>
          </div>
        )}
      </section>
      {error && <p role="alert" className="bl-error">{error}</p>}
      {message && <p role="status" className="bl-notice">{message}</p>}
    </section>
  );
}
