"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import Sidebar from "@/components/Sidebar";
import AddApplicationPanel from "@/components/AddApplicationPanel";

interface AppShellProps {
  children?: React.ReactNode;
  manualEntryEnabled?: boolean;
}

export default function AppShell({
  children,
  manualEntryEnabled = false,
}: AppShellProps) {
  const pathname = usePathname();
  const isDashboard = pathname === "/";
  const [panelOpen, setPanelOpen] = useState(isDashboard);

  useEffect(() => {
    setPanelOpen(isDashboard);
  }, [isDashboard]);

  if (pathname === "/connect") {
    return children;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6">
        {!isDashboard && (
          <div className="shell-add-toggle-row">
            <button
              type="button"
              className="primary-button shell-add-toggle"
              aria-expanded={panelOpen}
              aria-controls="add-application-panel"
              onClick={() => setPanelOpen((current) => !current)}
            >
              {panelOpen ? "Close add application" : "+ Add application"}
            </button>
          </div>
        )}
        <AddApplicationPanel
          open={panelOpen}
          onClose={isDashboard ? undefined : () => setPanelOpen(false)}
          manualEntryEnabled={manualEntryEnabled}
        />
        {children}
      </main>
    </div>
  );
}
