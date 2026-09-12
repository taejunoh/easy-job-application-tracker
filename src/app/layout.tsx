import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { getServerEnv } from "@/lib/server-env";

export const metadata: Metadata = {
  title: "JobTracker",
  description: "Track your job applications",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { validationManualEntryEnabled } = getServerEnv();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <AppShell manualEntryEnabled={validationManualEntryEnabled}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
