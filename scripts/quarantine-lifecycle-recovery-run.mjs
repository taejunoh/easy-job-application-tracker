// This is a fixed algorithm callback, not a callback factory or a brander.
// Its only effect is to enter recoverRestore with the capability handoff that
// the lifecycle boundary already validated.  A direct caller cannot forge a
// handoff, and cannot substitute arbitrary code at this authority boundary.
import { AsyncLocalStorage } from "node:async_hooks";

const recoveryStorage = new AsyncLocalStorage();

export const restoreRecoveryCallback = async (handoff) => {
  return recoveryStorage.run(handoff, async () => {
    const { recoverRestore } = await import("./quarantine-restore.mjs");
    return await recoverRestore(handoff.recoveryOptions);
  });
};

export function takeRestoreRecoveryHandoff(input) {
  const handoff = recoveryStorage.getStore();
  return handoff?.recoveryOptions === input ? handoff : null;
}
