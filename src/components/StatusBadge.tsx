const statusStyles: Record<string, string> = {
  Applied: "bg-blue-900/50 text-blue-400",
  Interview: "bg-yellow-900/50 text-yellow-400",
  Offer: "bg-green-900/50 text-green-400",
  Rejected: "bg-red-900/50 text-red-400",
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
      {status}
    </span>
  );
}
