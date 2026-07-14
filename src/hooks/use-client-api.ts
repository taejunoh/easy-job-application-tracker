"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { createClientApi, type ClientApi } from "@/lib/client-api";

export function useClientApi(): ClientApi {
  const router = useRouter();
  return useMemo(
    () => createClientApi((href) => router.replace(href)),
    [router],
  );
}
