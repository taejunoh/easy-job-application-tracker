import { calendarWeek, localCivilDate, utcDate } from "../../lib/application-calendar";
import type { LocalApplication } from "../storage";

type FollowUpsProps = {
  applications: readonly LocalApplication[];
  onEdit: (application: LocalApplication) => void;
  today?: Date;
};

type FollowUpGroup = {
  label: string;
  applications: LocalApplication[];
};

const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default function FollowUps({ applications, onEdit, today = new Date() }: FollowUpsProps) {
  const todayKey = localCivilDate(today);
  const weekEnd = calendarWeek(todayKey)[6];
  const groups: FollowUpGroup[] = [
    { label: "Overdue", applications: [] },
    { label: "Today", applications: [] },
    { label: "Later this week", applications: [] },
  ];

  for (const application of applications) {
    const due = application.nextStepDate;
    if (!due || application.status === "Rejected") continue;
    if (due < todayKey) groups[0].applications.push(application);
    else if (due === todayKey) groups[1].applications.push(application);
    else if (due <= weekEnd) groups[2].applications.push(application);
  }

  for (const group of groups) {
    group.applications.sort((left, right) =>
      (left.nextStepDate ?? "").localeCompare(right.nextStepDate ?? "")
      || left.company.localeCompare(right.company)
      || left.id.localeCompare(right.id));
  }

  return (
    <section className="bl-followups" aria-label="Follow-ups">
      <div className="bl-followup-grid">
        {groups.map(({ label, applications: items }) => (
          <section className="bl-followup-group" aria-label={label} key={label}>
            <h3>{label}</h3>
            {items.length ? items.map((application) => (
              <button className="bl-followup-item" key={application.id} type="button" onClick={() => onEdit(application)}>
                <strong>{application.company}</strong>
                <span>{application.jobTitle}</span>
                {application.nextStep && <small>{application.nextStep}</small>}
                <time dateTime={application.nextStepDate ?? undefined}>
                  {application.nextStepDate && dateLabel.format(utcDate(application.nextStepDate))}
                </time>
              </button>
            )) : <p className="bl-muted">No follow-ups</p>}
          </section>
        ))}
      </div>
    </section>
  );
}
