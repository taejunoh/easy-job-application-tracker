// This module deliberately has no public facade.  A recovery callback is
// branded by identity, so a caller cannot opt into the relaxed location
// classification with serializable input or a forged object.
const recoveryCallbacks = new WeakSet();

export function markRestoreRecoveryCallback(callback) {
  if (typeof callback !== "function") throw new TypeError("restore recovery callback must be a function");
  recoveryCallbacks.add(callback);
  return callback;
}

export function isRestoreRecoveryCallback(callback) {
  return typeof callback === "function" && recoveryCallbacks.has(callback);
}
