import { isIP } from "node:net";
import { basename, dirname, resolve } from "node:path";

const DATABASE_NAME = "jobtracker_extension_e2e_test";
const DESTRUCTIVE_ACKNOWLEDGEMENT =
  "jobtracker-extension-e2e-delete-all";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

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
  const exactPermission = `${origin}/*`;

  return {
    ...structuredClone(source),
    host_permissions: [fixtureHostPermission],
    optional_host_permissions: [exactPermission],
  };
}

/**
 * @param {string} value
 * @returns {{host: "127.0.0.1", port: number}}
 */
export function assertSafeExtensionE2EAdminUrl(value) {
  if (value.includes("\\")) {
    throw new Error("Refusing extension E2E: unsafe PostgreSQL admin target");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Refusing extension E2E: invalid local PostgreSQL admin URL");
  }
  const rawTarget = value.match(
    /^postgres(?:ql)?:\/\/([^/?#]+)\/postgres$/u,
  );
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.hostname !== "127.0.0.1" ||
    !/^[0-9]+$/u.test(url.port) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65_535 ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash ||
    rawTarget === null ||
    [...rawTarget[1]].filter((character) => character === "@").length > 1 ||
    rawTarget[1].slice(rawTarget[1].lastIndexOf("@") + 1) !==
      `127.0.0.1:${url.port}`
  ) {
    throw new Error("Refusing extension E2E: unsafe PostgreSQL admin target");
  }
  return Object.freeze({
    host: /** @type {"127.0.0.1"} */ (url.hostname),
    port: Number(url.port),
  });
}

/**
 * @param {{database?: unknown, address?: unknown, port?: unknown, version?: unknown}} row
 * @param {{host: "127.0.0.1", port: number}} target
 * @returns {{address: "127.0.0.1"}}
 */
export function assertLocalPostgres17Identity(row, target) {
  if (
    target.host !== "127.0.0.1" ||
    row?.database !== "postgres" ||
    row?.address !== target.host ||
    row?.port !== target.port ||
    typeof row?.version !== "number" ||
    row.version < 170_000 ||
    row.version >= 180_000
  ) {
    throw new Error(
      "Refusing extension E2E: live PostgreSQL 17 identity mismatch",
    );
  }
  return Object.freeze({ address: target.host });
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

/**
 * @param {{registrations?: unknown[], versions?: unknown[]}} state
 * @param {string} extensionId
 * @returns {{registrationId: string, scopeURL: string, versionId: string, targetId: string, scriptURL: string}}
 */
export function extensionServiceWorkerStateFromCdp(state, extensionId) {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error("Invalid extension ID for service worker state");
  }
  const scopeURL = `chrome-extension://${extensionId}/`;
  const registrations = Array.isArray(state?.registrations)
    ? state.registrations
    : [];
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  const registration = registrations.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      candidate.scopeURL === scopeURL &&
      candidate.isDeleted !== true &&
      typeof candidate.registrationId === "string",
  );
  const version = versions.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      candidate.registrationId === registration?.registrationId &&
      candidate.runningStatus === "running" &&
      candidate.scriptURL === `${scopeURL}background.js` &&
      typeof candidate.versionId === "string" &&
      typeof candidate.targetId === "string" &&
      candidate.targetId.length > 0,
  );
  if (!registration || !version) {
    throw new Error("extension service worker CDP state was unavailable");
  }
  return Object.freeze({
    registrationId: registration.registrationId,
    scopeURL,
    versionId: version.versionId,
    targetId: version.targetId,
    scriptURL: version.scriptURL,
  });
}

/**
 * Clear extension popup content before a failure screenshot. This function is
 * serialized into the popup execution context, so it must remain self-contained.
 *
 * @returns {string}
 */
export function redactPopupDocument() {
  const contentIds = [
    "analysisSection",
    "analysisBadge",
    "analysisSummary",
    "matchedPills",
    "missingPills",
    "analysisError",
  ];
  for (const id of contentIds) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.replaceChildren();
    element.textContent = "";
    element.hidden = true;
    element.style.display = "none";
  }

  for (const element of document.querySelectorAll("input, textarea")) {
    if ("value" in element) element.value = "";
    element.textContent = "";
    element.removeAttribute("value");
  }

  for (const id of [
    "serverUrl",
    "accessToken",
    "jobTitle",
    "company",
    "location",
    "jobUrl",
    "salary",
    "jobType",
    "description",
  ]) {
    const element = document.getElementById(id);
    if (!element) continue;
    if ("value" in element) element.value = "";
    element.textContent = "";
    element.removeAttribute("value");
  }

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name.startsWith("data-") ||
        ["href", "src", "srcset", "action", "formaction"].includes(
          attribute.name,
        )
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === "A") element.textContent = "";
  }

  const connectionStatus = document.getElementById("connectionStatus");
  if (connectionStatus) connectionStatus.textContent = "Status redacted";
  const status = document.getElementById("statusMsg");
  if (status) status.textContent = "E2E failure details redacted";
  return document.documentElement.outerHTML;
}

/**
 * @param {string} snapshot
 * @param {string[]} sensitiveValues
 */
export function assertSanitizedPopupSnapshot(snapshot, sensitiveValues) {
  if (typeof snapshot !== "string") {
    throw new Error("sanitized popup snapshot was unavailable");
  }
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0 && snapshot.includes(value)) {
      throw new Error("sanitized popup snapshot retained sensitive content");
    }
  }
}

/**
 * @param {string} workspacePath
 * @param {string} temporaryRoot
 * @returns {string}
 */
export function assertExtensionE2EWorkspacePath(
  workspacePath,
  temporaryRoot,
) {
  const root = resolve(temporaryRoot);
  const workspace = resolve(workspacePath);
  if (
    dirname(workspace) !== root ||
    !/^jobtracker-extension-e2e-[A-Za-z0-9]{6}$/u.test(
      basename(workspace),
    )
  ) {
    throw new Error("Refusing extension E2E workspace cleanup");
  }
  return workspace;
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
