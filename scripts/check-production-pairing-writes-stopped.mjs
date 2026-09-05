import { lstatSync, openSync, closeSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_RESPONSE_BYTES = 256 * 1024;
const PAIRING_CODE = /^jt_pair_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/u;

function privateEvidencePath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) throw new Error();
  const parent = dirname(value);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o777) !== 0o700) throw new Error();
  const stat = (() => { try { return lstatSync(value); } catch { return null; } })();
  if (stat !== null) throw new Error();
  return value;
}

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder(); let bytes = 0; let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function writePrivate(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, value, "utf8"); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}

export async function probePairingWritesStopped(config = process.env) {
  const origin = new URL(config.PRODUCTION_APP_URL);
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.username || origin.password || origin.pathname !== "/") throw new Error();
  const code = config.PRESTOP_PAIRING_CODE;
  const grantId = config.PRESTOP_PAIRING_GRANT_ID;
  const extensionOrigin = config.PRESTOP_PAIRING_ORIGIN;
  const parsed = typeof code === "string" ? code.match(PAIRING_CODE) : null;
  if (!parsed || parsed[1] !== grantId || typeof extensionOrigin !== "string" || !EXTENSION_ORIGIN.test(extensionOrigin)) throw new Error();
  const evidencePath = privateEvidencePath(config.PAIRING_PROBE_RESPONSE_FILE);
  const response = await fetch(new URL("/api/extension/pair", origin), {
    method: "POST", headers: { origin: extensionOrigin, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code }), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await boundedText(response);
  let body;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  writePrivate(evidencePath, JSON.stringify({ status: response.status, headers: { cacheControl: response.headers.get("cache-control"), retryAfter: response.headers.get("retry-after") }, body }));
  if (response.status !== 503 || response.headers.get("cache-control") !== "private, no-store" || response.headers.get("retry-after") !== "60" ||
      !body || typeof body !== "object" || Array.isArray(body) || body.error !== "Application writes are temporarily disabled" || body.code !== "writes_stopped" || body.retryable !== true || Object.keys(body).length !== 3) throw new Error();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { await probePairingWritesStopped(); process.stdout.write("Pairing write-stop probe passed.\n"); }
  catch { process.stderr.write("Pairing write-stop probe failed.\n"); process.exitCode = 1; }
}
