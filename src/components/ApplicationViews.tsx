"use client";

import type { KeyboardEvent } from "react";
import StatusBadge from "@/components/StatusBadge";
import { STATUSES } from "@/components/StatusEditor";
import { calendarWeek, groupScheduledApplications, utcDate } from "@/lib/application-calendar";
import type { ApplicationSummary } from "@/lib/application-record";

export const VIEWS = [
  { id: "list", label: "List", icon: "≡" },
  { id: "board", label: "Board", icon: "▥" },
  { id: "calendar", label: "Calendar", icon: "▦" },
] as const;

export type ApplicationView = (typeof VIEWS)[number]["id"];
export type OpenApplication = (id: string, trigger: HTMLElement) => void;

interface RecordViewProps {
  applications: readonly ApplicationSummary[];
  selectedId?: string;
  onOpen: OpenApplication;
}

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const calendarDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const calendarWeekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

export function ApplicationTabs({ view, onChange }: { view: ApplicationView; onChange: (view: ApplicationView) => void }) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % VIEWS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + VIEWS.length) % VIEWS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = VIEWS.length - 1;
    else return;
    event.preventDefault();
    onChange(VIEWS[next].id);
    document.getElementById(`application-tab-${VIEWS[next].id}`)?.focus();
  }

  return (
    <div className="workspace-tabs" role="tablist" aria-label="Application views">
      {VIEWS.map(({ id, label, icon }, index) => (
        <button
          key={id}
          id={`application-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={id === view}
          aria-controls={`application-view-${id}`}
          tabIndex={id === view ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <span aria-hidden="true">{icon}</span>{label}
        </button>
      ))}
    </div>
  );
}

export function ApplicationBoard({ applications, selectedId, onOpen }: RecordViewProps) {
  const other = applications.filter((record) => !STATUSES.includes(record.status));
  const lanes = STATUSES.map((status) => ({
    status,
    records: applications.filter((record) => record.status === status),
  }));
  if (other.length) lanes.push({ status: "Other", records: other });

  return (
    <div className="workspace-lanes">
      {lanes.map(({ status, records }) => (
        <section className="workspace-lane" aria-label={status} key={status}>
          <div className="workspace-lane-heading">
            <StatusBadge status={status} /><span className="workspace-mono">{records.length}</span>
          </div>
          {records.length === 0 && <p className="workspace-view-note">No applications</p>}
          {records.map((record) => (
            <button
              type="button"
              className="workspace-ticket"
              key={record.id}
              aria-pressed={selectedId === record.id}
              onClick={(event) => onOpen(record.id, event.currentTarget)}
            >
              <strong>{record.company}</strong>
              <span>{record.jobTitle}</span>
              <time className="workspace-mono" dateTime={record.appliedDate}>{shortDate.format(new Date(record.appliedDate))}</time>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

export function ApplicationCalendar({
  applications, selectedId, onOpen, today, offset, onChangeWeek,
}: RecordViewProps & { today: string; offset: number; onChangeWeek: (offset: number) => void }) {
  const days = calendarWeek(today, offset);
  const groups = groupScheduledApplications(applications, days);
  const unscheduled = applications.filter((application) => !application.nextStepDate).length;
  const first = utcDate(days[0]);
  const last = utcDate(days[6]);
  const yearRange = first.getUTCFullYear() === last.getUTCFullYear()
    ? String(last.getUTCFullYear())
    : `${first.getUTCFullYear()}–${last.getUTCFullYear()}`;

  return (
    <>
      <div className="workspace-calendar-toolbar">
        <div>
          <h2 aria-live="polite">{calendarDate.format(first)} – {calendarDate.format(last)}, {yearRange}</h2>
          <p className="workspace-view-note">Scheduled next steps</p>
        </div>
        <div className="workspace-calendar-controls">
          <button type="button" onClick={() => onChangeWeek(offset - 1)} aria-label="Previous week">‹</button>
          <button type="button" onClick={() => onChangeWeek(0)}>Today</button>
          <button type="button" onClick={() => onChangeWeek(offset + 1)} aria-label="Next week">›</button>
        </div>
      </div>
      <div className="workspace-week">
        {days.map((day) => {
          const date = utcDate(day);
          const events = groups.get(day) ?? [];
          return (
            <section className="workspace-day" key={day} aria-label={calendarDate.format(date)}>
              <time dateTime={day} className="workspace-day-heading" aria-current={day === today ? "date" : undefined}>
                <span>{calendarWeekday.format(date)}</span>
                <strong>{date.getUTCDate()}</strong>
              </time>
              <div className="workspace-day-events">
                {events.length === 0 && <span className="workspace-no-event" aria-hidden="true">—</span>}
                {events.map((record) => (
                  <button
                    type="button"
                    className="workspace-event"
                    key={record.id}
                    data-status={record.status}
                    aria-pressed={selectedId === record.id}
                    onClick={(event) => onOpen(record.id, event.currentTarget)}
                  >
                    <strong>{record.nextStep || "Next step"}</strong>
                    <span>{record.company}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="workspace-view-note workspace-calendar-note">
        {unscheduled} {unscheduled === 1 ? "application has" : "applications have"} no scheduled date.
        {groups.size === 0 && " Set a next step date in an application record to add it to the calendar."}
      </p>
    </>
  );
}
