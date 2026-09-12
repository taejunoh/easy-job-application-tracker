"use client";

import { usePathname } from "next/navigation";

import Sidebar from "@/components/Sidebar";
import UrlInputWrapper from "@/components/UrlInputWrapper";

interface AppShellProps {
  children?: React.ReactNode;
  manualEntryEnabled?: boolean;
}

export default function AppShell({
  children,
  manualEntryEnabled = false,
}: AppShellProps) {
  const pathname = usePathname();

  if (pathname === "/connect") {
    return children;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6">
        <div className="mb-6">
          <UrlInputWrapper manualEntryEnabled={manualEntryEnabled} />
        </div>
        {children}
      </main>
    </div>
  );
}
