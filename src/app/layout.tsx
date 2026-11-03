import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { connection } from "next/server";
import { getServerEnv } from "@/lib/server-env";
import { applicationWritesEnabled } from "@/lib/security/application-writes";

export const metadata: Metadata = {
  title: "JobTracker",
  description: "Track your job applications",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The write stop is a runtime flag; never bake it into prerendered HTML.
  await connection();
  const { validationManualEntryEnabled } = getServerEnv();
  const writesStopped = !applicationWritesEnabled();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <AppShell
          manualEntryEnabled={validationManualEntryEnabled}
          writesStopped={writesStopped}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
