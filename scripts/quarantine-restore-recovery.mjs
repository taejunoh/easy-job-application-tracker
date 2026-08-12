import { recoverRestoreWithHandoff } from "./quarantine-restore-internal.mjs";

// A recovery callback is deliberately created only here and always runs the
// fixed recovery algorithm.  It is not an alternate generic core entrypoint:
// callers cannot supply their own callback under this identity.
const fixedRecoveryCallbacks = new WeakSet();

export function createFixedRestoreRecoveryCallback(options) {
  const callback = async (handoff) => recoverRestoreWithHandoff(options, handoff);
  fixedRecoveryCallbacks.add(callback);
  return callback;
}

export function isFixedRestoreRecoveryCallback(callback) {
  return fixedRecoveryCallbacks.has(callback);
}
