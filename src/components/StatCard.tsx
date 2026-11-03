import Link from "next/link";

interface StatCardProps {
  label: string;
  /** `null` renders a dash for a value that could not be loaded. */
  value: number | null;
  color: string;
  hint?: string;
  href?: string;
}

export default function StatCard({ label, value, color, hint, href }: StatCardProps) {
  const content = (
    <>
      <div className={`stat-value ${color}`}>{value ?? "–"}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="stat-card card stat-card-link">
        {content}
      </Link>
    );
  }
  return <div className="stat-card card">{content}</div>;
}
