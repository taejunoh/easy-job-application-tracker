const statusStyles: Record<string, string> = {
  Applied: "status-applied",
  Interview: "status-interview",
  Offer: "status-offer",
  Rejected: "status-rejected",
};

const statusIcons: Record<string, string> = {
  Applied: "○",
  Interview: "◐",
  Offer: "★",
  Rejected: "×",
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs ${
        statusStyles[status] || "bg-gray-800 text-gray-400"
      }`}
    >
      <span aria-hidden="true">{statusIcons[status] || "•"}</span>
      <span data-status-label>{status}</span>
    </span>
  );
}
