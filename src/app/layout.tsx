import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { connection } from "next/server";
import { getServerEnv } from "@/lib/server-env";
import { applicationWritesEnabled } from "@/lib/security/application-writes";

const ibmPlexSans = localFont({
  src: [
    {
      path: "../../public/fonts/ibm-plex-sans-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../public/fonts/ibm-plex-sans-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  variable: "--font-ibm-plex-sans",
  display: "swap",
  adjustFontFallback: false,
  fallback: [
    "system-ui",
    "-apple-system",
    "BlinkMacSystemFont",
    "Apple SD Gothic Neo",
    "Malgun Gothic",
    "Avenir Next",
    "Avenir",
    "Segoe UI",
    "Helvetica Neue",
    "Helvetica",
    "sans-serif",
  ],
});

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
    <html lang="en" className={`h-full antialiased ${ibmPlexSans.variable}`}>
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
