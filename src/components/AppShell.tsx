"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ApplicationChangesContext } from "@/components/ApplicationChanges";
import Sidebar from "@/components/Sidebar";
import AddApplicationPanel from "@/components/AddApplicationPanel";
import { PageHeaderSlotContext } from "@/components/PageHeader";
import {
  READ_ONLY_MESSAGE,
  WritesStoppedProvider,
} from "@/components/WriteState";

interface AppShellProps {
  children?: React.ReactNode;
  manualEntryEnabled?: boolean;
  writesStopped?: boolean;
}

export default function AppShell({
  children,
  manualEntryEnabled = false,
  writesStopped = false,
}: AppShellProps) {
  const pathname = usePathname();
  const isDashboard = pathname === "/";
  const [panelOpen, setPanelOpen] = useState(isDashboard);
  const [revision, setRevision] = useState(0);
  const notify = useCallback(() => setRevision((current) => current + 1), []);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPanelOpen(isDashboard);
  }, [isDashboard]);

  if (pathname === "/connect") {
    return children;
  }

  return (
    <WritesStoppedProvider value={writesStopped}>
      <ApplicationChangesContext.Provider value={{ revision, notify }}>
        <PageHeaderSlotContext.Provider value={headerSlot}>
          <div className="app-shell">
            <Sidebar />
            <main className="app-main">
              {writesStopped && (
                <div role="status" className="read-only-banner">
                  <strong>{READ_ONLY_MESSAGE}</strong>
                </div>
              )}
              <div ref={setHeaderSlot} className="page-header-slot" />
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
        </PageHeaderSlotContext.Provider>
      </ApplicationChangesContext.Provider>
    </WritesStoppedProvider>
  );
}
