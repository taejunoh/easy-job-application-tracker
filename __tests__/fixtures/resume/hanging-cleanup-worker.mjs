import { parentPort } from "node:worker_threads";

parentPort.postMessage({ ok: true, text: "finished before cleanup" });
await new Promise(() => undefined);
