"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { analyzeKeywordMatch } from "@/lib/keyword-matcher";
import { useClientApi } from "@/hooks/use-client-api";
import type { ClientApi } from "@/lib/client-api";

interface Application {
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  description: string | null;
  notes: string | null;
  salary: string | null;
  location: string | null;
  jobType: string | null;
}

const STATUSES = ["Applied", "Interview", "Offer", "Rejected"];
const JOB_TYPES = ["", "Remote", "Hybrid", "Onsite"];

interface ApplicationDetailProps {
  application: Application;
}

export default function ApplicationDetail({
  application,
}: ApplicationDetailProps) {
  const router = useRouter();
  const api = useClientApi();
  const [form, setForm] = useState({
    jobTitle: application.jobTitle,
    company: application.company,
    status: application.status,
    description: application.description || "",
    notes: application.notes || "",
    salary: application.salary || "",
    location: application.location || "",
    jobType: application.jobType || "",
  });
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const [saved, setSaved] = useState(false);
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [debouncedDescription, setDebouncedDescription] = useState(form.description);

  useEffect(() => {
    api<{ resumeText?: string | null }>("/api/settings?includeResume=true")
      .then((data) => setResumeText(data.resumeText || ""))
      .catch((failure: unknown) => {
        setResumeText("");
        setError(errorMessage(failure, "Failed to load resume settings."));
      });
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDescription(form.description), 300);
    return () => clearTimeout(timer);
  }, [form.description]);

  const keywordAnalysis = useMemo(() => {
    if (!debouncedDescription || !resumeText) return null;
    return analyzeKeywordMatch(debouncedDescription, resumeText);
  }, [debouncedDescription, resumeText]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await saveApplicationChanges(api, () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }, application.id, form);
    } catch (failure) {
      setError(errorMessage(failure, "Failed to save application."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      await deleteApplication(
        api,
        (href) => router.push(href),
        application.id,
      );
    } catch (failure) {
      setError(errorMessage(failure, "Failed to delete application."));
      setDeleting(false);
    }
  }

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <div className="application-detail">
      <button type="button" onClick={() => router.push("/applications")} className="back-link">
        &larr; Back to Applications
      </button>

      {error && <div role="alert" className="inline-alert">{error}</div>}

      <article className="application-detail-card">
        <header className="application-detail-header">
          <div className="application-identity">
            <p className="eyebrow">Application record</p>
            <label htmlFor="application-job-title" className="field-label">Job title</label>
            <input id="application-job-title" value={form.jobTitle} onChange={(e) => updateField("jobTitle", e.target.value)} className="detail-title-input" />
            <label htmlFor="application-company" className="field-label">Company</label>
            <input id="application-company" value={form.company} onChange={(e) => updateField("company", e.target.value)} className="detail-company-input" />
          </div>
          <label htmlFor="application-status" className="status-field">
            <span className="input-label">Status</span>
            <select id="application-status" value={form.status} onChange={(e) => updateField("status", e.target.value)} className="field status-select">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </header>

        <section className="metadata-section" aria-labelledby="metadata-heading">
          <h2 id="metadata-heading" className="section-title">Application details</h2>
          <div className="metadata-grid">
            <div className="metadata-item">
              <span className="input-label">Date Applied</span>
              <time dateTime={application.appliedDate}>{new Date(application.appliedDate).toLocaleDateString()}</time>
            </div>
            <label htmlFor="application-location" className="field-label">
              <span className="input-label">Location</span>
              <input id="application-location" value={form.location} onChange={(e) => updateField("location", e.target.value)} placeholder="e.g., San Francisco, CA" className="field" />
            </label>
            <label htmlFor="application-salary" className="field-label">
              <span className="input-label">Salary Range</span>
              <input id="application-salary" value={form.salary} onChange={(e) => updateField("salary", e.target.value)} placeholder="e.g., $120k - $160k" className="field" />
            </label>
            <label htmlFor="application-job-type" className="field-label">
              <span className="input-label">Job Type</span>
              <select id="application-job-type" value={form.jobType} onChange={(e) => updateField("jobType", e.target.value)} className="field">
                {JOB_TYPES.map((t) => <option key={t} value={t}>{t || "Not specified"}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="detail-section description-section" aria-labelledby="description-heading">
          <h2 id="description-heading" className="section-title">Job Description</h2>
          <p className="section-copy">Keep the original listing close while you prepare.</p>
          <label htmlFor="application-description" className="field-label sr-only">Job Description</label>
          <textarea id="application-description" value={form.description} onChange={(e) => updateField("description", e.target.value)} placeholder="Paste the job description here..." rows={6} className="field detail-textarea" />
        </section>

        {form.description && resumeText === "" && (
          <div className="resume-guidance" role="note">
            Add your resume in <a href="/settings" className="text-link" onClick={(event) => { event.preventDefault(); router.push("/settings"); }}>Settings</a> to see keyword match analysis.
          </div>
        )}

        {keywordAnalysis && keywordAnalysis.totalJobKeywords > 0 && (
          <section className="detail-section analysis-section" aria-labelledby="analysis-heading">
            <button type="button" aria-expanded={showAnalysis} aria-controls="keyword-analysis-content" onClick={() => setShowAnalysis(!showAnalysis)} className={`analysis-toggle ${keywordScoreClass(keywordAnalysis.matchPercentage)}`}>
              <span className="analysis-toggle-content">
                <span className="section-title" id="analysis-heading" role="heading" aria-level={2}>Keyword Match Analysis</span>
                <span className="match-percentage">{keywordAnalysis.matchPercentage}%</span>
              </span>
              <span aria-hidden="true" className="analysis-chevron">{showAnalysis ? "▲" : "▼"}</span>
            </button>
            {showAnalysis && (
              <div id="keyword-analysis-content" className="analysis-content">
                <div className="progress-track"><div className={`progress-value ${keywordScoreClass(keywordAnalysis.matchPercentage)}`} style={{ width: `${keywordAnalysis.matchPercentage}%` }} /></div>
                <p className="section-copy">{keywordAnalysis.matchedKeywords.length} of {keywordAnalysis.totalJobKeywords} keywords matched</p>
                {keywordAnalysis.matchedKeywords.length > 0 && <div className="keyword-group"><h4>Matched</h4><div className="keyword-list">{keywordAnalysis.matchedKeywords.map((k) => <span key={k.keyword} className="keyword-chip matched-chip">{k.keyword}</span>)}</div></div>}
                {keywordAnalysis.missingKeywords.length > 0 && <div className="keyword-group"><h4>Missing</h4><div className="keyword-list">{keywordAnalysis.missingKeywords.map((k) => <span key={k.keyword} className="keyword-chip missing-chip">{k.keyword}</span>)}</div></div>}
              </div>
            )}
          </section>
        )}

        <section className="detail-section notes-section" aria-labelledby="notes-heading">
          <h2 id="notes-heading" className="section-title">Notes</h2>
          <label htmlFor="application-notes" className="field-label sr-only">Notes</label>
          <textarea id="application-notes" value={form.notes} onChange={(e) => updateField("notes", e.target.value)} placeholder="Add notes about this application..." rows={4} className="field detail-textarea" />
        </section>

        <section className="detail-section source-section" aria-labelledby="source-heading">
          <h2 id="source-heading" className="section-title">Source URL</h2>
          <a href={application.url} target="_blank" rel="noopener noreferrer" className="text-link source-link">{application.url}</a>
        </section>

        <footer className="detail-actions">
          <div className="save-actions">
            <button type="button" onClick={handleSave} disabled={saving} className="primary-button">{saving ? "Saving..." : "Save Changes"}</button>
            {saved && <span role="status" className="saved-status">Saved</span>}
          </div>
          <div className="destructive-actions">
            <span className="destructive-label">Permanent action</span>
            {showDeleteConfirm ? (
              <div className="delete-confirmation"><span>Are you sure?</span><button type="button" onClick={handleDelete} disabled={deleting} className="danger-button">{deleting ? "Deleting..." : "Yes, Delete"}</button><button type="button" onClick={() => setShowDeleteConfirm(false)} className="secondary-button">Cancel</button></div>
            ) : <button type="button" onClick={() => setShowDeleteConfirm(true)} className="danger-link">Delete Application</button>}
          </div>
        </footer>
      </article>
      <style>{applicationDetailStyles}</style>
    </div>
  );
}

const applicationDetailStyles = `
.application-detail { min-width: 0; }
.back-link { background: transparent; border: 0; color: var(--muted); cursor: pointer; display: inline-flex; margin-bottom: 1rem; padding: 0.5rem 0; }
.application-detail-card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; box-shadow: var(--shadow); min-width: 0; padding: clamp(1rem, 3vw, 2rem); }
.application-detail-header { align-items: flex-start; border-bottom: 1px solid var(--border); display: flex; gap: 1.5rem; justify-content: space-between; padding-bottom: 1.5rem; }
.application-identity { min-width: 0; }
.application-identity .field-label { margin-top: 0.6rem; }
.field-label { color: var(--muted); display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; min-width: 0; text-transform: uppercase; }
.detail-title-input, .detail-company-input { background: transparent; border: 0; border-bottom: 1px solid transparent; color: var(--text); display: block; min-width: 0; outline: 0; padding: 0.2rem 0; width: 100%; }
.detail-title-input { font-family: Georgia, "Times New Roman", serif; font-size: clamp(1.7rem, 4vw, 2.4rem); font-weight: 600; letter-spacing: -0.03em; }
.detail-company-input { color: var(--muted); font-size: 1rem; margin-top: 0.1rem; }
.detail-title-input:hover, .detail-company-input:hover, .detail-title-input:focus, .detail-company-input:focus { border-color: var(--primary); }
.status-field { flex: 0 0 min(11rem, 35%); min-width: 8.5rem; }
.input-label { color: var(--muted); display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; margin-bottom: 0.35rem; text-transform: uppercase; }
.field { background: var(--surface); border: 1px solid var(--border); border-radius: 0.5rem; color: var(--text); min-width: 0; padding: 0.6rem 0.7rem; width: 100%; }
.field:focus { border-color: var(--primary); outline: 3px solid color-mix(in srgb, var(--primary) 35%, transparent); outline-offset: 1px; }
.metadata-section { border-bottom: 1px solid var(--border); padding: 1.5rem 0; }
.metadata-grid { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 0.9rem; }
.metadata-item time { color: var(--text); display: block; padding: 0.65rem 0; }
.section-title { color: var(--primary); font-family: Georgia, "Times New Roman", serif; font-size: 1.35rem; font-weight: 600; margin: 0; }
.detail-section { border-bottom: 1px solid var(--border); min-width: 0; padding: 1.5rem 0; }
.section-copy { color: var(--muted); font-size: 0.85rem; line-height: 1.5; margin: 0.4rem 0 0.8rem; }
.detail-textarea { display: block; line-height: 1.55; resize: vertical; }
.resume-guidance { background: #f6f0e4; border: 1px solid #d8c8a9; border-radius: 0.5rem; color: #68562d; font-size: 0.9rem; line-height: 1.5; margin: 1.5rem 0 0; padding: 0.9rem 1rem; }
.text-link { color: var(--primary); font-weight: 700; text-decoration: underline; text-underline-offset: 0.15em; }
.analysis-toggle { align-items: center; background: transparent; border: 0; border-radius: 0.5rem; cursor: pointer; display: flex; gap: 0.75rem; justify-content: space-between; min-height: 44px; padding: 0; text-align: left; width: 100%; }
.analysis-toggle-content { align-items: center; display: flex; gap: 0.75rem; min-width: 0; }
.match-percentage { border: 1px solid; border-radius: 999px; font-size: 0.8rem; font-weight: 700; padding: 0.3rem 0.6rem; }
.score-high .match-percentage { background: #e7f2e9; border-color: #8ab697; color: #245e3a; }
.score-medium .match-percentage { background: #fbf0df; border-color: #d9ad6d; color: #81551d; }
.score-low .match-percentage { background: #fae9e9; border-color: #d79599; color: var(--destructive); }
.analysis-chevron { color: var(--muted); font-size: 0.8rem; }
.analysis-content { border-top: 1px solid var(--border); margin-top: 0.75rem; padding-top: 1rem; }
.progress-track { background: #e7ece7; border-radius: 999px; height: 0.5rem; overflow: hidden; }
.progress-value { border-radius: inherit; height: 100%; transition: width 180ms ease; }
.progress-value.score-high { background: var(--primary); }
.progress-value.score-medium { background: #b57b2c; }
.progress-value.score-low { background: var(--destructive); }
.keyword-group { margin-top: 1rem; }
.keyword-group h4 { color: var(--muted); font-size: 0.72rem; letter-spacing: 0.08em; margin: 0 0 0.45rem; text-transform: uppercase; }
.keyword-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.keyword-chip { border: 1px solid; border-radius: 999px; font-size: 0.8rem; padding: 0.3rem 0.55rem; }
.matched-chip { background: #e7f2e9; border-color: #8ab697; color: #245e3a; }
.missing-chip { background: #fae9e9; border-color: #d79599; color: var(--destructive); }
.source-link { display: block; font-size: 0.9rem; line-height: 1.5; margin-top: 0.7rem; overflow-wrap: anywhere; }
.detail-actions { align-items: flex-end; display: flex; gap: 1rem; justify-content: space-between; padding-top: 1.5rem; }
.save-actions, .delete-confirmation { align-items: center; display: flex; flex-wrap: wrap; gap: 0.6rem; }
.primary-button, .danger-button, .secondary-button { border-radius: 0.5rem; cursor: pointer; min-height: 44px; padding: 0.6rem 1rem; }
.primary-button { background: var(--primary); border: 1px solid var(--primary); color: #fff; font-weight: 700; }
.primary-button:disabled, .danger-button:disabled { cursor: wait; opacity: 0.6; }
.saved-status { color: #245e3a; font-size: 0.9rem; font-weight: 700; }
.destructive-actions { align-items: flex-end; display: flex; flex-direction: column; gap: 0.25rem; }
.destructive-label { color: var(--muted); font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; }
.danger-link { background: transparent; border: 0; color: var(--destructive); cursor: pointer; min-height: 44px; padding: 0.6rem 0; text-decoration: underline; }
.danger-button { background: var(--destructive); border: 1px solid var(--destructive); color: #fff; font-weight: 700; }
.secondary-button { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
.delete-confirmation > span { color: var(--muted); font-size: 0.85rem; }
@media (max-width: 768px) { .application-detail-header, .detail-actions { flex-direction: column; } .status-field { flex-basis: auto; min-width: 0; width: 100%; } .metadata-grid { grid-template-columns: 1fr; } .destructive-actions { align-items: flex-start; width: 100%; } }
`;

export async function saveApplicationChanges(
  api: ClientApi,
  markSaved: () => void,
  id: string,
  form: Record<string, string>,
): Promise<void> {
  await api(`/api/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serializeApplicationChanges(form)),
  });
  markSaved();
}

export function serializeApplicationChanges(
  form: Record<string, string>,
): Record<string, string | null> {
  const nullableFields = new Set([
    "description",
    "notes",
    "salary",
    "location",
    "jobType",
  ]);
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [
      key,
      nullableFields.has(key) && value.trim() === "" ? null : value,
    ]),
  );
}

export async function deleteApplication(
  api: ClientApi,
  navigate: (href: string) => void,
  id: string,
): Promise<void> {
  await api(`/api/applications/${id}`, { method: "DELETE" });
  navigate("/applications");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function keywordScoreClass(matchPercentage: number): string {
  return matchPercentage >= 70
    ? "score-high"
    : matchPercentage >= 40
      ? "score-medium"
      : "score-low";
}
