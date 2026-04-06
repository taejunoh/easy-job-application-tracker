"use client";

import dynamic from "next/dynamic";

const UrlInput = dynamic(() => import("@/components/UrlInput"), { ssr: false });

export default function UrlInputWrapper() {
  return <UrlInput />;
}
