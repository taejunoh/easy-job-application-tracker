import { useEffect, useMemo, useState } from "react";
import {
  LOCAL_JOB_TYPES, LOCAL_STATUSES, type createLocalTrackerStorage,
  type LocalApplication, type LocalApplicationInput, type LocalSettings,
} from "../storage";
import ApplicationEditor from "./ApplicationEditor";
import { ApplicationBoard, ApplicationCalendar, ApplicationList, VIEWS, type View } from "./ApplicationViews";
import { BackupPanel, ResumePanel } from "./SettingsPanels";
import { filterApplications, sortApplications } from "./model";

export type TrackerStorage = ReturnType<typeof createLocalTrackerStorage>;
type Section = "Applications" | "Résumé" | "Backup";

export default function BrowserLocalApp({ storage }: { storage: TrackerStorage }) {
  const [applications, setApplications] = useState<LocalApplication[]>([]);
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [section, setSection] = useState<Section>("Applications");
  const [view, setView] = useState<View>("list");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [jobTypeFilter, setJobTypeFilter] = useState("");
  const [editor, setEditor] = useState<LocalApplication | null | undefined>(undefined);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([storage.listApplications(), storage.getSettings()]).then(([records, savedSettings]) => {
      if (cancelled) return;
      setApplications(records);
      setSettings(savedSettings);
      setLoadError(false);
    }).catch(() => {
      if (!cancelled) setLoadError(true);
    });
    return () => { cancelled = true; };
  }, [storage, loadAttempt]);

  const statuses = [...new Set([...LOCAL_STATUSES, ...applications.map(({ status }) => status)])];
  const jobTypes = [...new Set<string>([...LOCAL_JOB_TYPES, ...applications.flatMap(({ jobType }) => jobType ? [jobType] : [])])];
  const filtered = useMemo(() => {
    const records = jobTypeFilter ? applications.filter(({ jobType }) => jobType === jobTypeFilter) : applications;
    return sortApplications(filterApplications(records, search, statusFilter));
  }, [applications, jobTypeFilter, search, statusFilter]);

  async function saveApplication(input: LocalApplicationInput) {
    if (editor) {
      const updated = await storage.updateApplication(editor.id, input, editor.updatedAt);
      setApplications((records) => records.map((record) => record.id === updated.id ? updated : record));
      setNotice("Application updated.");
    } else {
      const created = await storage.createApplication(input);
      setApplications((records) => [created, ...records]);
      setNotice("Application added.");
    }
  }

  async function deleteApplication() {
    if (!editor) return;
    await storage.deleteApplication(editor.id, editor.updatedAt);
    setApplications((records) => records.filter((record) => record.id !== editor.id));
    setNotice("Application deleted.");
  }

  return (
    <div className="bl-app">
      <header className="bl-top">
        <div className="bl-top-inner">
          <div className="bl-brand"><span className="bl-brand-icon" aria-hidden="true">J/</span>JobTracker</div>
          <nav className="bl-nav" aria-label="Main">
            {(["Applications", "Résumé", "Backup"] as const).map((item) => (
              <button key={item} type="button" aria-current={section === item ? "page" : undefined}
                onClick={() => { setSection(item); setNotice(""); }}>{item}</button>
            ))}
          </nav>
          <span className="bl-local"><i aria-hidden="true" /> Local storage</span>
        </div>
      </header>
      <main className="bl-main">
        <div className="bl-page-head">
          <div>
            <h1>{section}</h1>
            {section === "Applications" && <p>Track applications and keep your next steps in view.</p>}
            {section === "Résumé" && <p>Save résumé text to compare against the skills in a job description.</p>}
            {section === "Backup" && <p>Download a copy of your tracker or restore it on another browser.</p>}
          </div>
          {section === "Applications" && settings && (
            <button className="bl-button bl-primary" type="button" onClick={() => { setNotice(""); setEditor(null); }}>+ Add application</button>
          )}
        </div>
        {notice && <p className="bl-notice" role="status">{notice}</p>}
        {loadError ? (
          <div className="bl-panel">
            <p className="bl-error" role="alert">Could not read this browser’s data. Check that browser storage is available and try again.</p>
            <button className="bl-button" type="button" onClick={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }}>Retry loading</button>
          </div>
        ) : !settings ? <p role="status">Loading your tracker…</p> : (
          <>
            {section === "Applications" && (
              <>
                <div className="bl-stats" aria-label="Application totals">
                  <div className="bl-stat"><span>Total applications</span><strong>{applications.length}</strong></div>
                  {LOCAL_STATUSES.map((status) => (
                    <div className="bl-stat" key={status} data-status={status}>
                      <span>{status}</span><strong>{applications.filter((item) => item.status === status).length}</strong>
                    </div>
                  ))}
                </div>
                <section className="bl-panel bl-applications" aria-label="Application records">
                  <div className="bl-tools">
                    <div className="bl-view-switch" role="group" aria-label="Application view">
                      {VIEWS.map(({ id, label }) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
                    </div>
                    <div className="bl-filters">
                      <label className="bl-search">
                        <span className="bl-visually-hidden">Search applications</span>
                        <input type="search" placeholder="Search applications" value={search} onChange={(event) => setSearch(event.target.value)} />
                      </label>
                      <label>
                        <span className="bl-visually-hidden">Filter by status</span>
                        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                          <option value="">All statuses</option>
                          {statuses.map((status) => <option key={status}>{status}</option>)}
                        </select>
                      </label>
                      <label>
                        <span className="bl-visually-hidden">Filter by job type</span>
                        <select value={jobTypeFilter} onChange={(event) => setJobTypeFilter(event.target.value)}>
                          <option value="">All job types</option>
                          {jobTypes.map((jobType) => <option key={jobType}>{jobType}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                  {view === "list" && (filtered.length ? (
                    <ApplicationList applications={filtered} onEdit={setEditor} />
                  ) : (
                    <div className="bl-empty">
                      <h2>{applications.length ? "No matching applications" : "No applications yet"}</h2>
                      {applications.length ? <button type="button" className="bl-button" onClick={() => { setSearch(""); setStatusFilter(""); setJobTypeFilter(""); }}>Clear filters</button> : <p>Use Add application to log your first role.</p>}
                    </div>
                  ))}
                  {view === "board" && <ApplicationBoard applications={filtered} onEdit={setEditor} statuses={statusFilter ? [statusFilter] : statuses} />}
                  {view === "calendar" && <ApplicationCalendar applications={filtered} onEdit={setEditor} />}
                </section>
              </>
            )}
            {section === "Résumé" && <ResumePanel settings={settings} onSave={async (resumeText) => {
              const next = { ...settings, resumeText };
              await storage.saveSettings(next, settings);
              setSettings(next);
              setNotice("Résumé saved in this browser.");
            }} />}
            {section === "Backup" && <BackupPanel storage={storage} onRestore={() => {
              setStatusFilter("");
              setJobTypeFilter("");
              setSearch("");
              setNotice("Backup restored.");
              setSettings(null);
              setLoadAttempt((attempt) => attempt + 1);
            }} />}
            {editor !== undefined && <ApplicationEditor
              application={editor} resumeText={settings.resumeText}
              onSave={saveApplication} onDelete={deleteApplication} onClose={() => setEditor(undefined)}
            />}
          </>
        )}
        <footer className="bl-footer">Data stays in this browser profile. Clearing site data removes your tracker, so keep a backup.</footer>
      </main>
    </div>
  );
}
