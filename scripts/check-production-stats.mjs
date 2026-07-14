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

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function getStatsUrl() {
  const baseUrl = new URL(process.env.PRODUCTION_APP_URL);
  if (
    baseUrl.username ||
    baseUrl.password ||
    (baseUrl.protocol !== "https:" && !isLoopback(baseUrl.hostname))
  ) {
    throw new Error("Invalid production origin");
  }
  return new URL("/api/stats", baseUrl.origin);
}

function hasExactStatsShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== STAT_KEYS.length) return false;
  if (!STAT_KEYS.every((key) => keys.includes(key))) return false;
  return (
    STAT_KEYS.slice(0, -1).every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    ) && Array.isArray(value.recentApplications)
  );
}

async function main() {
  const token = process.env.PRODUCTION_APP_ACCESS_TOKEN;
  if (!token) throw new Error("Missing monitor credential");
  const timeoutMs = Number(process.env.PRODUCTION_MONITOR_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new Error("Invalid timeout");
  }

  const response = await fetch(getStatsUrl(), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error("Unexpected status");
  const stats = await response.json();
  if (!hasExactStatsShape(stats)) throw new Error("Unexpected response");
}

try {
  await main();
  console.log("Production monitor passed.");
} catch {
  console.error("Production monitor failed.");
  process.exitCode = 1;
}
