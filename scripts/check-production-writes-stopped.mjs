import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const STAT_KEYS = [
  "total",
  "applied",
  "interview",
  "offer",
  "rejected",
  "weeklyCount",
  "monthlyCount",
  "recentApplications",
];
const APPLICATION_KEYS = [
  "id",
  "url",
  "jobTitle",
  "company",
  "status",
  "appliedDate",
  "description",
  "notes",
  "salary",
  "location",
  "jobType",
  "createdAt",
  "updatedAt",
];
const REQUIRED_STRING_FIELDS = [
  "id",
  "url",
  "jobTitle",
  "company",
  "status",
  "appliedDate",
  "createdAt",
  "updatedAt",
];
const NULLABLE_STRING_FIELDS = [
  "description",
  "notes",
  "salary",
  "location",
  "jobType",
];
const WRITE_STOP_RESPONSE = {
  error: "Application writes are temporarily disabled",
  code: "writes_stopped",
  retryable: true,
};

function isLoopback(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function getOrigin() {
  const configured = process.env.PRODUCTION_APP_URL;
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error("Invalid production origin");
  }
  const origin = new URL(configured);
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username ||
    origin.password ||
    configured.includes("?") ||
    configured.includes("#") ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !isLoopback(origin.hostname))
  ) {
    throw new Error("Invalid production origin");
  }
  return origin;
}

function getTimeoutMs() {
  const configured = process.env.PRODUCTION_MONITOR_TIMEOUT_MS;
  const timeoutMs = Number(configured ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Invalid timeout");
  }
  return timeoutMs;
}

function hasExactApplicationShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== APPLICATION_KEYS.length) return false;
  if (!APPLICATION_KEYS.every((key) => keys.includes(key))) return false;
  if (!REQUIRED_STRING_FIELDS.every((key) => typeof value[key] === "string")) return false;
  return NULLABLE_STRING_FIELDS.every(
    (key) => value[key] === null || typeof value[key] === "string",
  );
}

function hasExactStatsShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== STAT_KEYS.length || !STAT_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  return (
    STAT_KEYS.slice(0, -1).every(
      (key) => Number.isInteger(value[key]) && value[key] >= 0,
    ) &&
    Array.isArray(value.recentApplications) &&
    value.recentApplications.every(hasExactApplicationShape)
  );
}

async function readBoundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readJson(response) {
  const text = await readBoundedText(response);
  return JSON.parse(text);
}

async function authenticatedStats(origin, token, timeoutMs) {
  const response = await fetch(new URL("/api/stats", origin), {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("Unexpected stats status");
  }
  const stats = await readJson(response);
  if (!hasExactStatsShape(stats)) throw new Error("Unexpected stats response");
  return stats;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function syntheticApplication() {
  const id = randomUUID();
  return {
    url: `https://production-write-stop-probe.invalid/${id}`,
    jobTitle: `Synthetic write-stop title ${id}`,
    company: `Synthetic write-stop company ${id}`,
    status: "Applied",
    appliedDate: new Date().toISOString(),
    description: null,
    notes: null,
    salary: null,
    location: null,
    jobType: null,
  };
}

async function main() {
  const token = process.env.PRODUCTION_APP_ACCESS_TOKEN;
  if (typeof token !== "string" || token.trim() === "") throw new Error("Missing monitor credential");
  const origin = getOrigin();
  const timeoutMs = getTimeoutMs();
  const before = await authenticatedStats(origin, token, timeoutMs);

  const response = await fetch(new URL("/api/applications", origin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: origin.origin,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(syntheticApplication()),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 503) {
    await response.body?.cancel();
    throw new Error("Unexpected write-stop status");
  }
  if (
    response.headers.get("cache-control") !== "private, no-store" ||
    response.headers.get("retry-after") !== "60"
  ) {
    await response.body?.cancel();
    throw new Error("Unexpected write-stop headers");
  }
  const payload = await readJson(response);
  const payloadKeys = Object.keys(payload).sort();
  const expectedKeys = Object.keys(WRITE_STOP_RESPONSE).sort();
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payloadKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => payloadKeys.includes(key)) ||
    payload.error !== WRITE_STOP_RESPONSE.error ||
    payload.code !== WRITE_STOP_RESPONSE.code ||
    payload.retryable !== WRITE_STOP_RESPONSE.retryable
  ) {
    throw new Error("Unexpected write-stop response");
  }

  const after = await authenticatedStats(origin, token, timeoutMs);
  if (canonicalJson(before) !== canonicalJson(after)) throw new Error("Stats changed during probe");
}

try {
  await main();
  console.log("Production write-stop probe passed.");
} catch {
  console.error("Production write-stop probe failed.");
  process.exitCode = 1;
}
