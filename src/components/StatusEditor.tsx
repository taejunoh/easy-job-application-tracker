"use client";

import { useEffect, useRef, useState } from "react";

import StatusBadge from "@/components/StatusBadge";

export const STATUSES = ["Applied", "Interview", "Offer", "Rejected"];

interface StatusEditorProps {
  id: string;
  jobTitle: string;
  status: string;
  onChange: (id: string, status: string) => void;
  /** When set, the status is shown as a plain badge that cannot be edited. */
  readOnlyReason?: string;
}

/**
 * Shows the status as the same colored badge the dashboard uses. Activating it
 * (click, Enter, or Space on the button) reveals a native select; choosing a
 * value reports it through onChange, and Escape or leaving the select cancels.
 */
export default function StatusEditor({
  id,
  jobTitle,
  status,
  onChange,
  readOnlyReason,
}: StatusEditorProps) {
  const [editing, setEditing] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      selectRef.current?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  if (readOnlyReason !== undefined) {
    return (
      <span title={readOnlyReason}>
        <StatusBadge status={status} />
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        ref={buttonRef}
        type="button"
        className="status-edit-button"
        aria-label={`Status for ${jobTitle}: ${status}. Change status`}
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <StatusBadge status={status} />
        <span aria-hidden="true" className="status-edit-caret">▾</span>
      </button>
    );
  }

  return (
    <select
      ref={selectRef}
      id={`application-status-${id}`}
      value={status}
      aria-label={`Status for ${jobTitle}`}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          restoreFocus.current = true;
          setEditing(false);
        }
      }}
      onChange={(event) => {
        event.stopPropagation();
        restoreFocus.current = true;
        setEditing(false);
        onChange(id, event.target.value);
      }}
    >
      {STATUSES.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
