import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const readyPath = process.env.EXTENSION_E2E_SIGNAL_READY_PATH;
const marker = process.env.EXTENSION_E2E_SIGNAL_MARKER;
if (!readyPath || !marker) {
  throw new Error("extension E2E signal fixture controls are required");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => undefined);
}

const grandchild = spawn(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => undefined);
    }
    setInterval(() => undefined, 1000);`,
    marker,
  ],
  { stdio: "ignore" },
);
if (!Number.isInteger(grandchild.pid)) {
  throw new Error("extension E2E signal fixture grandchild did not start");
}

await writeFile(
  readyPath,
  `${JSON.stringify({
    parentPid: process.pid,
    grandchildPid: grandchild.pid,
    marker,
  })}\n`,
  { mode: 0o600 },
);

setInterval(() => undefined, 1_000);
