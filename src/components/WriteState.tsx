"use client";

import { createContext, useContext } from "react";

/** Shown in the shell banner and as the reason on controls that cannot work. */
export const READ_ONLY_MESSAGE = "Read-only mode: changes are temporarily disabled";

const WritesStoppedContext = createContext(false);

export const WritesStoppedProvider = WritesStoppedContext.Provider;

/**
 * True when the server reports that application writes are stopped. Components
 * disable only the controls whose API routes are guarded by that stop.
 */
export function useWritesStopped(): boolean {
  return useContext(WritesStoppedContext);
}

/** `title` text for a control that is disabled by the write stop. */
export function readOnlyTitle(stopped: boolean): string | undefined {
  return stopped ? READ_ONLY_MESSAGE : undefined;
}
