"use client";

import { usePathname } from "next/navigation";

import Sidebar from "@/components/Sidebar";
import UrlInputWrapper from "@/components/UrlInputWrapper";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/connect") {
    return children;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6">
        <div className="mb-6">
          <UrlInputWrapper />
        </div>
        {children}
      </main>
    </div>
  );
}
