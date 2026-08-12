import { withExistingQuarantineRunInternal } from "./quarantine-lifecycle-internal.mjs";

// The generic entry point is intentionally strict.  Recovery has a separate
// private entry so no callback shape, symbol, or direct import can grant this
// public API authority to classify mismatched restore locations.
export async function withExistingQuarantineRun(options, callback) {
  return withExistingQuarantineRunInternal(options, callback);
}
