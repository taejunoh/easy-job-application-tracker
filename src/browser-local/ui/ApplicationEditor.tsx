import { useEffect, useRef, useState, type FormEvent } from "react";
import { localCivilDate } from "../../lib/application-calendar";
import { analyzeKeywordMatch } from "../../lib/keyword-matcher";
import { DuplicateJobUrlError, LocalBackupCapacityError, LocalDataChangedError, LOCAL_JOB_TYPES, LOCAL_STATUSES, type LocalApplication, type LocalApplicationInput } from "../storage";
import GeminiExtract from "./GeminiExtract";

export default function ApplicationEditor({ application, resumeText, onSave, onDelete, onClose }: {
  application: LocalApplication | null;
  resumeText: string;
  onSave: (input: LocalApplicationInput) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const company = useRef<HTMLInputElement>(null);
  const jobTitle = useRef<HTMLInputElement>(null);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [description, setDescription] = useState(application?.description ?? "");
  const [match, setMatch] = useState<ReturnType<typeof analyzeKeywordMatch> | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function close() {
    setClosing(true);
    dialog.current?.close();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    const optional = (name: string) => field(name) || null;
    const input: LocalApplicationInput = {
      company: field("company"),
      jobTitle: field("jobTitle"),
      url: field("url"),
      status: field("status"),
      appliedDate: field("appliedDate"),
      description: optional("description"),
      notes: optional("notes"),
      salary: optional("salary"),
      location: optional("location"),
      jobType: optional("jobType"),
      nextStep: optional("nextStep"),
      nextStepDate: optional("nextStepDate"),
    };
    if (!input.company || !input.jobTitle) {
      setError("Enter a company and job title.");
      return;
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      setError("Enter a valid posting URL beginning with https:// or http://.");
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      setError("Enter a valid posting URL beginning with https:// or http://.");
      return;
    }
    if (url.username || url.password) {
      setError("Use a posting URL without credentials.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await onSave(input);
      close();
    } catch (failure) {
      if (failure instanceof DuplicateJobUrlError) {
        setError("An application with this posting URL is already tracked.");
      } else if (failure instanceof LocalDataChangedError) {
        setError("This record changed in another tab. Copy your edits before closing this form, then reload the tracker.");
      } else if (failure instanceof LocalBackupCapacityError) {
        setError("This save would exceed the 32 MiB backup limit. Shorten the job description or notes and try again. Your changes are still in this form.");
      } else {
        setError("Could not save the application. Your changes are still in this form.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await onDelete();
      close();
    } catch (failure) {
      setError(failure instanceof LocalDataChangedError
        ? "This record changed in another tab. Reload the tracker before deleting it."
        : "Could not delete the application. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="bl-dialog" aria-labelledby="bl-editor-title" onCancel={(event) => {
      event.preventDefault();
      if (!busy) close();
    }}>
      <div className="bl-dialog-inner">
        <header className="bl-section-head">
          <h2 id="bl-editor-title">{application ? "Edit application" : "Add application"}</h2>
          <button className="bl-button" type="button" onClick={close} disabled={busy}>Close</button>
        </header>
        {!closing && !busy && !deleting && <GeminiExtract onApply={(fields) => {
          if (company.current && fields.company) company.current.value = fields.company;
          if (jobTitle.current && fields.jobTitle) jobTitle.current.value = fields.jobTitle;
          (fields.company ? company.current : jobTitle.current)?.focus();
        }} />}
        <form onSubmit={submit}>
          <fieldset disabled={busy || deleting} className="bl-form-grid">
            <label>Company<input ref={company} name="company" required maxLength={256} defaultValue={application?.company} /></label>
            <label>Job title<input ref={jobTitle} name="jobTitle" required maxLength={256} defaultValue={application?.jobTitle} /></label>
            <label className="bl-wide">Posting URL<input name="url" required type="url" maxLength={2048} defaultValue={application?.url} /></label>
            <label>Status
              <select name="status" defaultValue={application?.status ?? "Applied"}>
                {application && !LOCAL_STATUSES.some((status) => status === application.status) &&
                  <option>{application.status}</option>}
                {LOCAL_STATUSES.map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
            <label>Date applied<input name="appliedDate" required type="date" defaultValue={application?.appliedDate.slice(0, 10) ?? localCivilDate(new Date())} /></label>
            <label>Location<input name="location" maxLength={512} defaultValue={application?.location ?? ""} /></label>
            <label>Job type
              <select name="jobType" defaultValue={application?.jobType ?? ""}>
                <option value="">Unspecified</option>
                {application?.jobType && !LOCAL_JOB_TYPES.some((jobType) => jobType === application.jobType) &&
                  <option>{application.jobType}</option>}
                {LOCAL_JOB_TYPES.map((jobType) => <option key={jobType}>{jobType}</option>)}
              </select>
            </label>
            <label className="bl-wide">Salary<input name="salary" maxLength={512} defaultValue={application?.salary ?? ""} placeholder="e.g. $90,000–$110,000" /></label>
            <label>Next step<input name="nextStep" maxLength={120} defaultValue={application?.nextStep ?? ""} /></label>
            <label>Next step date<input name="nextStepDate" type="date" defaultValue={application?.nextStepDate ?? ""} /></label>
            <label className="bl-wide">Job description
              <textarea name="description" rows={4} maxLength={100_000} value={description} onChange={(event) => {
                setDescription(event.target.value);
                setMatch(null);
              }} />
            </label>
            <div className="bl-wide">
              <button className="bl-button" type="button" disabled={!description.trim() || !resumeText.trim()}
                onClick={() => setMatch(analyzeKeywordMatch(description, resumeText))}>Check résumé keywords</button>
              {!resumeText.trim() && <p className="bl-muted">Save your résumé text in the Résumé tab to check keywords.</p>}
              {match && (
                <div className="bl-match" role="status">
                  {match.totalJobKeywords ? <>
                    <strong>{match.matchPercentage}% keyword match</strong>
                    <p>Matched: {match.matchedKeywords.map(({ keyword }) => keyword).join(", ") || "None"}</p>
                    <p>Missing: {match.missingKeywords.map(({ keyword }) => keyword).join(", ") || "None"}</p>
                  </> : <p>No known skill keywords found in this job description.</p>}
                </div>
              )}
            </div>
            <label className="bl-wide">Notes<textarea name="notes" rows={4} maxLength={20_000} defaultValue={application?.notes ?? ""} /></label>
          </fieldset>
          {error && <p className="bl-error" role="alert">{error}</p>}
          {deleting ? (
            <div className="bl-confirm">
              <p>Delete this application and its notes?</p>
              <div className="bl-actions">
                <button type="button" className="bl-button" disabled={busy} onClick={() => setDeleting(false)}>Keep application</button>
                <button type="button" className="bl-button bl-danger" disabled={busy} onClick={remove}>Delete application</button>
              </div>
            </div>
          ) : (
            <footer className="bl-actions bl-dialog-actions">
              {application && <button type="button" className="bl-button bl-danger" disabled={busy} onClick={() => setDeleting(true)}>Delete…</button>}
              <button className="bl-button bl-primary" disabled={busy} type="submit">{busy ? "Saving…" : "Save application"}</button>
            </footer>
          )}
        </form>
      </div>
    </dialog>
  );
}
