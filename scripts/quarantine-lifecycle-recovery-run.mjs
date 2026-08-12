import { withExistingQuarantineRunInternal } from "./quarantine-lifecycle-internal.mjs";

// Private recovery-only entry.  It is deliberately not re-exported through
// any public facade; its narrower authority is usable only by restore code.
export async function withRestoreRecoveryRun(options, callback) {
  return withExistingQuarantineRunInternal(options, callback, {
    allowRestoreLocationConflict: true,
  });
}
