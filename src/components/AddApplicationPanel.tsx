"use client";

import UrlInputWrapper from "@/components/UrlInputWrapper";

interface AddApplicationPanelProps {
  open: boolean;
  onClose?: () => void;
  manualEntryEnabled?: boolean;
}

export default function AddApplicationPanel({
  open,
  onClose,
  manualEntryEnabled = false,
}: AddApplicationPanelProps) {
  return (
    <section
      id="add-application-panel"
      aria-labelledby="add-application-heading"
      aria-hidden={!open}
      hidden={!open}
      className={`add-application-panel card ${open ? "is-open" : "is-closed"}`}
    >
      <div className="panel-heading-row">
        <div>
          <p className="eyebrow">Journal entry</p>
          <h2 id="add-application-heading" className="panel-heading">Add application</h2>
        </div>
        {onClose && (
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close add application">
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <p className="panel-copy">Capture a role while the details are fresh.</p>
      <UrlInputWrapper manualEntryEnabled={manualEntryEnabled} />
    </section>
  );
}
