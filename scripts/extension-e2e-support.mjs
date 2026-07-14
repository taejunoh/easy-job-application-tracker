import { isIP } from "node:net";

const DATABASE_NAME = "jobtracker_extension_e2e_test";
const DESTRUCTIVE_ACKNOWLEDGEMENT =
  "jobtracker-extension-e2e-delete-all";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const LOCAL_PERMISSION_PATTERNS = new Set([
  "http://127.0.0.1/*",
  "http://localhost/*",
]);

/**
 * @param {Record<string, string | undefined>} environment
 * @returns {{host: "127.0.0.1" | "localhost", port: number, database: string, serverAddress: string}}
 */
export function assertSafeExtensionE2EEnvironment(environment) {
  if (environment.RUN_EXTENSION_E2E !== "1") {
    refuse("RUN_EXTENSION_E2E must equal 1");
  }
  if (
    environment.ALLOW_DESTRUCTIVE_EXTENSION_E2E !==
    DESTRUCTIVE_ACKNOWLEDGEMENT
  ) {
    refuse(
      "ALLOW_DESTRUCTIVE_EXTENSION_E2E must equal jobtracker-extension-e2e-delete-all",
    );
  }

  const rawUrl = environment.DATABASE_URL ?? "";
  if (rawUrl.includes("\\")) {
    refuse("DATABASE_URL authority is not canonical");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    refuse("DATABASE_URL must be a canonical PostgreSQL URL");
  }

  if (
    url.protocol !== "postgres:" &&
    url.protocol !== "postgresql:"
  ) {
    refuse("DATABASE_URL must be a PostgreSQL URL");
  }
  if (url.search || url.hash || !LOOPBACK_HOSTS.has(url.hostname)) {
    refuse("DATABASE_URL must use only an allowed loopback endpoint");
  }
  if (
    !/^[0-9]+$/u.test(url.port) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65_535
  ) {
    refuse("DATABASE_URL must include an explicit numeric port");
  }

  const rawTarget = rawUrl.match(
    /^postgres(?:ql)?:\/\/([^/?#]+)(\/[^?#]*)$/u,
  );
  if (
    rawTarget === null ||
    [...rawTarget[1]].filter((character) => character === "@").length > 1 ||
    rawTarget[1].slice(rawTarget[1].lastIndexOf("@") + 1) !==
      `${url.hostname}:${url.port}` ||
    rawTarget[2] !== `/${DATABASE_NAME}` ||
    url.pathname !== `/${DATABASE_NAME}`
  ) {
    refuse("DATABASE_URL must target the exact canonical E2E database");
  }

  const serverAddress = environment.EXPECTED_DATABASE_SERVER_ADDRESS ?? "";
  if (serverAddress.includes("%") || isIP(serverAddress) === 0) {
    refuse(
      "EXPECTED_DATABASE_SERVER_ADDRESS must be an explicit IP address",
    );
  }

  return Object.freeze({
    host: /** @type {"127.0.0.1" | "localhost"} */ (url.hostname),
    port: Number(url.port),
    database: DATABASE_NAME,
    serverAddress,
  });
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} serverOrigin
 * @param {string} fixtureHostPermission
 * @returns {Record<string, unknown> & {host_permissions: string[], optional_host_permissions: string[]}}
 */
export function buildE2EManifest(
  source,
  serverOrigin,
  fixtureHostPermission,
) {
  const origin = exactLoopbackOrigin(serverOrigin);
  if (fixtureHostPermission !== "https://jobs.lever.co/*") {
    throw new Error("Invalid deterministic extension E2E fixture permission");
  }
  const hostPermissions = Array.isArray(source.host_permissions)
    ? source.host_permissions.filter(
        (permission) => typeof permission === "string",
      )
    : [];
  if (!hostPermissions.includes(fixtureHostPermission)) {
    hostPermissions.push(fixtureHostPermission);
  }
  const originalPermissions = Array.isArray(source.optional_host_permissions)
    ? source.optional_host_permissions.filter(
        (permission) => typeof permission === "string",
      )
    : [];
  const optionalHostPermissions = originalPermissions.filter(
    (permission) => !LOCAL_PERMISSION_PATTERNS.has(permission),
  );
  const exactPermission = `${origin}/*`;
  if (!optionalHostPermissions.includes(exactPermission)) {
    optionalHostPermissions.push(exactPermission);
  }

  return {
    ...structuredClone(source),
    host_permissions: hostPermissions,
    optional_host_permissions: optionalHostPermissions,
  };
}

/**
 * @param {string} workerUrl
 * @returns {{id: string, origin: string}}
 */
export function extensionIdentityFromWorkerUrl(workerUrl) {
  let url;
  try {
    url = new URL(workerUrl);
  } catch {
    throw new Error("Invalid extension service worker URL");
  }
  if (
    url.protocol !== "chrome-extension:" ||
    !EXTENSION_ID_PATTERN.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid extension service worker URL");
  }
  return Object.freeze({
    id: url.hostname,
    origin: `chrome-extension://${url.hostname}`,
  });
}

/** @param {string} output @returns {number} */
export function parseDockerPort(output) {
  const match = output.trim().match(/^127\.0\.0\.1:([0-9]+)$/u);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid loopback Docker port");
  }
  return port;
}

/** @param {string} value @returns {string} */
function exactLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid loopback extension E2E origin");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^[0-9]+$/u.test(url.port) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid loopback extension E2E origin");
  }
  return url.origin;
}

/** @param {string} reason @returns {never} */
function refuse(reason) {
  throw new Error(`Refusing destructive extension E2E: ${reason}`);
}
