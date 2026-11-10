"use client";

import { createContext, useContext } from "react";

export const ApplicationChangesContext = createContext<{
  revision: number;
  notify: (() => void) | null;
}>({ revision: 0, notify: null });

export function useApplicationChanges() {
  return useContext(ApplicationChangesContext);
}
