import { useState } from "react";
import { calendarWeek, groupScheduledApplications, localCivilDate, utcDate } from "../../lib/application-calendar";
import type { LocalApplication } from "../storage";

export type View = "list" | "board" | "calendar";
export const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: "list", label: "List" },
  { id: "board", label: "Board" },
  { id: "calendar", label: "Calendar" },
];

type ViewProps = {
  applications: readonly LocalApplication[];
  onEdit: (application: LocalApplication) => void;
};

const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekdayLabel = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

export function Status({ status }: { status: string }) {
  return <span className="bl-status" data-status={status}>{status}</span>;
}

export function ApplicationList({ applications, onEdit }: ViewProps) {
  return (
    <div className="bl-table-wrap">
      <table className="bl-table">
        <thead><tr>
          <th scope="col">Company / role</th>
          <th scope="col">Status</th>
          <th scope="col">Location</th>
          <th scope="col">Applied</th>
          <th scope="col">Next step</th>
        </tr></thead>
        <tbody>{applications.map((application) => (
          <tr key={application.id}>
            <th scope="row">
              <button type="button" className="bl-record-link" onClick={() => onEdit(application)}>
                <strong>{application.company}</strong><span>{application.jobTitle}</span>
              </button>
            </th>
            <td><Status status={application.status} /></td>
            <td>{[application.location, application.jobType].filter(Boolean).join(" · ") || "—"}</td>
            <td><time dateTime={application.appliedDate}>{dateLabel.format(new Date(application.appliedDate))}</time></td>
            <td>
              {application.nextStep ?? (!application.nextStepDate && "—")}
              {application.nextStepDate && <time className="bl-date" dateTime={application.nextStepDate}>{dateLabel.format(utcDate(application.nextStepDate))}</time>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function ApplicationBoard({ applications, onEdit, statuses }: ViewProps & { statuses: readonly string[] }) {
  return (
    <div className="bl-board">
      {statuses.map((status) => {
        const records = applications.filter((record) => record.status === status);
        return (
          <section className="bl-lane" aria-label={status} key={status}>
            <div className="bl-lane-title"><Status status={status} /><span>{records.length}</span></div>
            {records.length === 0 && <p className="bl-muted">No applications</p>}
            {records.map((application) => <Ticket key={application.id} application={application} onEdit={onEdit} />)}
          </section>
        );
      })}
    </div>
  );
}

function Ticket({ application, onEdit, showStep }: { application: LocalApplication; onEdit: ViewProps["onEdit"]; showStep?: boolean }) {
  return (
    <button type="button" className="bl-ticket" onClick={() => onEdit(application)}>
      <strong>{application.company}</strong><span>{application.jobTitle}</span>
      {showStep && application.nextStep && <small>{application.nextStep}</small>}
    </button>
  );
}

export function ApplicationCalendar({ applications, onEdit }: ViewProps) {
  const [offset, setOffset] = useState(0);
  const today = localCivilDate(new Date());
  const days = calendarWeek(today, offset);
  const scheduled = groupScheduledApplications(applications, days);

  return (
    <div className="bl-calendar">
      <div className="bl-section-head">
        <div><h3>Next steps</h3><p className="bl-muted" aria-live="polite">{dateLabel.format(utcDate(days[0]))} – {dateLabel.format(utcDate(days[6]))}</p></div>
        <div className="bl-actions">
          <button className="bl-button" type="button" onClick={() => setOffset(offset - 1)}>Previous week</button>
          <button className="bl-button" type="button" onClick={() => setOffset(0)}>This week</button>
          <button className="bl-button" type="button" onClick={() => setOffset(offset + 1)}>Next week</button>
        </div>
      </div>
      <div className="bl-days">
        {days.map((day) => {
          const date = utcDate(day);
          return (
            <section className="bl-day" data-today={day === today} key={day} aria-label={dateLabel.format(date)}>
              <h4><time dateTime={day}>{weekdayLabel.format(date)} <strong>{date.getUTCDate()}</strong></time></h4>
              {scheduled.get(day)?.map((application) => <Ticket key={application.id} application={application} onEdit={onEdit} showStep />)}
            </section>
          );
        })}
      </div>
      {!scheduled.size && <p className="bl-muted">No next steps scheduled for this week.</p>}
    </div>
  );
}
