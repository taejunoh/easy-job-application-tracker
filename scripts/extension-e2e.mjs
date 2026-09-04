import { spawn } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { chromium } from "playwright";

import {
  E2E_ACCESS_TOKEN,
  E2E_CONFIGURED_APP_ORIGIN,
  E2E_ENCRYPTION_SECRET,
  E2E_INVALID_ACCESS_TOKEN,
  E2E_SERVER_HOST,
  E2E_SERVER_ORIGIN,
  E2E_SERVER_PORT,
  LEVER_EXPECTED_APPLICATION,
  LEVER_FIXTURE_HTML,
  LEVER_FIXTURE_URL,
} from "./extension-e2e-fixtures.mjs";
import {
  assertExtensionE2EWorkspacePath,
  assertSanitizedPopupSnapshot,
  assertSafeExtensionE2EEnvironment,
  buildE2EManifest,
  EXTENSION_E2E_WAKE_ACK,
  EXTENSION_E2E_WAKE_CHANNEL,
  EXTENSION_E2E_WAKE_MESSAGE,
  extensionE2EWakeListenerSource,
  extensionIdentityFromWorkerUrl,
  extensionServiceWorkerStateFromCdp,
  extensionServiceWorkerWakeUrl,
  redactPopupDocument,
} from "./extension-e2e-support.mjs";

const { Client } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(root, ".artifacts/extension-e2e");
const permissionPattern = `${E2E_SERVER_ORIGIN}/*`;
const popupArtifactSensitiveValues = [
  E2E_ACCESS_TOKEN,
  E2E_INVALID_ACCESS_TOKEN,
  E2E_ENCRYPTION_SECRET,
  E2E_SERVER_ORIGIN,
  E2E_CONFIGURED_APP_ORIGIN,
  ...Object.values(LEVER_EXPECTED_APPLICATION),
  "TypeScript",
  "PostgreSQL",
  "Kubernetes",
];
const processState = {
  browserVersion: "unknown",
  browserCdps: [],
  contexts: [],
  database: null,
  extensionIds: [],
  profileDirectory: null,
  popups: [],
  server: null,
  checkpoint: "safety-validation",
  failureCode: "none",
  step: "safety validation",
};
let cleanupPromise = null;
let handlingSignal = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (handlingSignal) return;
    handlingSignal = true;
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

async function run() {
  const expectedIdentity = assertSafeExtensionE2EEnvironment(process.env);
  await rm(artifactsDirectory, { recursive: true, force: true });
  await access(join(root, ".next/BUILD_ID"));

  processState.step = "live database identity verification";
  const database = new Client({ connectionString: process.env.DATABASE_URL });
  processState.database = database;
  await database.connect();
  await verifyLiveDatabaseIdentity(database, expectedIdentity);

  processState.step = "database migration";
  await runCommand(
    process.execPath,
    [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"],
    process.env,
  );
  await verifyLiveDatabaseIdentity(database, expectedIdentity);
  await resetDatabase(database);
  await seedResume(database);

  processState.step = "isolated extension preparation";
  const workspace = assertExtensionE2EWorkspacePath(
    await mkdtemp(join(tmpdir(), "jobtracker-extension-e2e-")),
    tmpdir(),
  );
  processState.profileDirectory = workspace;
  const extensionDirectoryA = join(workspace, "extension-a");
  const extensionDirectoryB = join(workspace, "extension-b");
  const browserProfileA = join(workspace, "browser-profile-a");
  const browserProfileB = join(workspace, "browser-profile-b");
  await prepareExtension(extensionDirectoryA);
  await prepareExtension(extensionDirectoryB);

  processState.step = "two isolated Chromium installations launch";
  const installationA = await launchInstallation(
    extensionDirectoryA,
    browserProfileA,
  );
  const installationB = await launchInstallation(
    extensionDirectoryB,
    browserProfileB,
  );
  requireCondition(
    installationA.identity.origin !== installationB.identity.origin,
    "isolated extension origins matched",
  );
  let { context, browserCdp, worker, identity } = installationA;
  processState.browserVersion = context.browser()?.version() ?? "unknown";

  processState.step = "local application startup";
  processState.server = startServer([
    installationA.identity.origin,
    installationB.identity.origin,
  ]);
  await waitForServer(processState.server, identity.origin);

  processState.step = "admin session and exact configured origins";
  const adminCookie = await createAdminSession();
  await requireConfiguredOrigins(adminCookie, [
    installationA.identity.origin,
    installationB.identity.origin,
  ]);

  processState.step = "root bearer rejection from Chrome origin";
  await requireRootBearerRejected(identity.origin);

  processState.step = "deterministic job fixture";
  await installJobFixture(context);
  await installJobFixture(installationB.context);
  const jobPage = await context.newPage();
  await jobPage.goto(LEVER_FIXTURE_URL, { waitUntil: "domcontentloaded" });
  const jobPageB = await installationB.context.newPage();
  await jobPageB.goto(LEVER_FIXTURE_URL, { waitUntil: "domcontentloaded" });

  processState.step = "optional host permission test setup";
  await grantOptionalHostPermission(context, identity.id);

  processState.step = "disconnected popup";
  let popup = await openActionPopup(
    browserCdp,
    worker,
    jobPage,
    identity.origin,
  );
  rememberPopup(popup);
  await waitForPopupExtraction(popup);
  await waitForText(popup, "#connectionStatus", "Disconnected");

  processState.step = "invalid pairing rejection";
  await connectFromPopup(popup, E2E_INVALID_ACCESS_TOKEN);
  await waitForText(popup, "#connectionStatus", "not accepted");
  await requireEmptyTokenInput(popup);
  await requireCredentialAndPermissionState(popup, {
    hasCredential: false,
    hasPermission: false,
  });

  processState.step = "origin-bound pairing rejection";
  await popup.close();
  forgetPopup(popup);
  const grantA = await createPairingGrant(adminCookie, identity.origin);
  await grantOptionalHostPermission(
    installationB.context,
    installationB.identity.id,
  );
  let popupB = await openActionPopup(
    installationB.browserCdp,
    installationB.worker,
    jobPageB,
    installationB.identity.origin,
  );
  rememberPopup(popupB);
  await connectFromPopup(popupB, grantA.code);
  await waitForText(popupB, "#connectionStatus", "not accepted");
  await requireCredentialAndPermissionState(popupB, {
    hasCredential: false,
    hasPermission: false,
  });

  processState.step = "valid extension pairing";
  await popupB.close();
  forgetPopup(popupB);
  await grantOptionalHostPermission(context, identity.id);
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  rememberPopup(popup);
  await waitForText(popup, "#connectionStatus", "Disconnected");
  await connectFromPopup(popup, grantA.code);
  await waitForText(popup, "#connectionStatus", "Connected to");
  await requireEmptyTokenInput(popup);
  await requireCredentialAndPermissionState(popup, {
    hasCredential: true,
    hasPermission: true,
  });
  const connectionA = await readInstallationConnection(popup);

  processState.step = "one-time pairing replay rejection";
  await replayConsumedPairingCodeFromOrigin(grantA.code, identity.origin);

  processState.step = "concurrent same-origin pairing consumption";
  await proveConcurrentPairingConsumption(
    adminCookie,
    identity.origin,
    database,
  );

  processState.step = "expired pairing rejection";
  const expiredGrant = await createPairingGrant(
    adminCookie,
    installationB.identity.origin,
  );
  await expirePairingGrant(database, expiredGrant.id);
  await grantOptionalHostPermission(
    installationB.context,
    installationB.identity.id,
  );
  popupB = await openActionPopup(
    installationB.browserCdp,
    installationB.worker,
    jobPageB,
    installationB.identity.origin,
  );
  rememberPopup(popupB);
  await connectFromPopup(popupB, expiredGrant.code);
  await waitForText(popupB, "#connectionStatus", "not accepted");

  processState.step = "two-install isolation";
  await popupB.close();
  forgetPopup(popupB);
  const grantB = await createPairingGrant(
    adminCookie,
    installationB.identity.origin,
  );
  await grantOptionalHostPermission(
    installationB.context,
    installationB.identity.id,
  );
  popupB = await openActionPopup(
    installationB.browserCdp,
    installationB.worker,
    jobPageB,
    installationB.identity.origin,
  );
  rememberPopup(popupB);
  await connectFromPopup(popupB, grantB.code);
  await waitForText(popupB, "#connectionStatus", "Connected to");
  const connectionB = await readInstallationConnection(popupB);
  requireCondition(
    connectionA.installationId !== connectionB.installationId,
    "two installations shared an identifier",
  );
  await requireInstallationScope(connectionB, installationB.identity.origin);
  await requireTwoActiveInstallations(database, connectionA, connectionB);

  processState.step = "MV3 worker restart and connection restoration";
  await popup.close();
  forgetPopup(popup);
  worker = await restartExtensionServiceWorker(
    browserCdp,
    context,
    jobPage,
    worker,
    identity.id,
  );
  updateDiagnostic("popup-restore", "restart-popup-restore");
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  rememberPopup(popup);
  await waitForText(popup, "#connectionStatus", "Connected to");
  await requireEmptyTokenInput(popup);
  await requireCredentialAndPermissionState(popup, {
    hasCredential: true,
    hasPermission: true,
  });

  processState.step = "job extraction";
  await assertExtractedApplication(popup);

  processState.step = "application save";
  await popup.click("#saveBtn");
  await waitForText(popup, "#statusMsg", "Application saved");
  await assertDatabaseApplication(database);

  processState.step = "keyword analysis";
  await popup.click("#analyzeBtn");
  await popup.waitForVisible("#analysisSection", 10_000);
  const analysisBadge = await popup.text("#analysisBadge");
  requireCondition(/^\d+%$/u.test(analysisBadge ?? ""), "analysis did not render");
  const sanitizedSnapshot = await popup.redact();
  assertSanitizedPopupSnapshot(
    sanitizedSnapshot,
    popupArtifactSensitiveValues,
  );

  processState.step = "action popup reopen and connection restoration";
  await popup.close();
  forgetPopup(popup);
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  rememberPopup(popup);
  await waitForText(popup, "#connectionStatus", "Connected to");
  await requireEmptyTokenInput(popup);

  processState.step = "revoke one installation without affecting the other";
  await popup.click("#disconnectBtn");
  await waitForText(popup, "#connectionStatus", "Disconnected");
  await requireCredentialAndPermissionState(popup, {
    hasCredential: false,
    hasPermission: false,
  });
  await waitForText(popupB, "#connectionStatus", "Connected to");
  await requireCredentialAndPermissionState(popupB, {
    hasCredential: true,
    hasPermission: true,
  });
  await requireRevocationIsolation(database, connectionA, connectionB);

  processState.step = "stored credential 401 invalidation";
  await database.query(
    'UPDATE "ExtensionInstallation" SET "revokedAt" = now(), "updatedAt" = now() WHERE "id" = $1',
    [connectionB.installationId],
  );
  await popupB.close();
  forgetPopup(popupB);
  popupB = await openActionPopup(
    installationB.browserCdp,
    installationB.worker,
    jobPageB,
    installationB.identity.origin,
  );
  rememberPopup(popupB);
  await waitForText(popupB, "#connectionStatus", "Connection expired");
  await requireCredentialAndPermissionState(popupB, {
    hasCredential: false,
    hasPermission: false,
  });
  await popup.close();
  forgetPopup(popup);
  await popupB.close();
  forgetPopup(popupB);

  processState.step = "final database cleanup verification";
  await resetDatabase(database);
  const remaining = await database.query(
    'SELECT count(*)::integer AS count FROM "Application"',
  );
  requireCondition(remaining.rows[0]?.count === 0, "test application remained");
}

async function prepareExtension(extensionDirectory) {
  await cp(join(root, "extension"), extensionDirectory, { recursive: true });
  const manifestPath = join(extensionDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      buildE2EManifest(
        manifest,
        E2E_SERVER_ORIGIN,
        "https://jobs.lever.co/*",
      ),
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await appendFile(
    join(extensionDirectory, "background.js"),
    `\n\n${extensionE2EWakeListenerSource()}\n`,
    { mode: 0o600 },
  );
}

async function launchInstallation(extensionDirectory, browserProfile) {
  const context = await chromium.launchPersistentContext(browserProfile, {
    channel: "chromium",
    headless: process.env.EXTENSION_E2E_HEADED !== "1",
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  processState.contexts.push(context);
  const browserCdp = await context.browser().newBrowserCDPSession();
  processState.browserCdps.push(browserCdp);
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  }
  const identity = extensionIdentityFromWorkerUrl(worker.url());
  processState.extensionIds.push(identity.id);
  return { context, browserCdp, worker, identity };
}

async function installJobFixture(context) {
  await context.route(LEVER_FIXTURE_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: LEVER_FIXTURE_HTML,
    });
  });
}

async function createAdminSession() {
  const response = await fetch(`${E2E_SERVER_ORIGIN}/api/auth/session`, {
    method: "POST",
    headers: {
      Origin: E2E_CONFIGURED_APP_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: E2E_ACCESS_TOKEN }),
  });
  requireCondition(response.status === 200, "admin session creation failed");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  requireCondition(cookie?.startsWith("jobtracker_session="), "session cookie missing");
  return cookie;
}

async function requireConfiguredOrigins(cookie, origins) {
  const response = await fetch(
    `${E2E_SERVER_ORIGIN}/api/extension/installations`,
    {
      headers: {
        Origin: E2E_CONFIGURED_APP_ORIGIN,
        Cookie: cookie,
      },
    },
  );
  requireCondition(response.status === 200, "installation list failed");
  const body = await response.json();
  requireCondition(
    JSON.stringify(body.configuredOrigins) === JSON.stringify(origins),
    "configured extension origins mismatch",
  );
}

async function requireRootBearerRejected(origin) {
  const response = await fetch(`${E2E_SERVER_ORIGIN}/api/auth/verify`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer ${E2E_ACCESS_TOKEN}`,
    },
  });
  requireCondition(response.status === 401, "root bearer worked from Chrome origin");
}

async function createPairingGrant(cookie, origin) {
  const response = await fetch(`${E2E_SERVER_ORIGIN}/api/extension/pairing`, {
    method: "POST",
    headers: {
      Origin: E2E_CONFIGURED_APP_ORIGIN,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ origin }),
  });
  requireCondition(response.status === 201, "pairing grant creation failed");
  const grant = await response.json();
  requireCondition(
    typeof grant.id === "string" &&
      typeof grant.code === "string" &&
      grant.origin === origin,
    "pairing grant response mismatch",
  );
  popupArtifactSensitiveValues.push(grant.code);
  return grant;
}

async function replayConsumedPairingCodeFromOrigin(code, origin) {
  const response = await fetch(`${E2E_SERVER_ORIGIN}/api/extension/pair`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  requireCondition(
    response.status === 401,
    "consumed pairing code replayed from its bound origin",
  );
}

async function proveConcurrentPairingConsumption(cookie, origin, database) {
  const grant = await createPairingGrant(cookie, origin);
  const consume = () =>
    fetch(`${E2E_SERVER_ORIGIN}/api/extension/pair`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: grant.code }),
    });
  const responses = await Promise.all([consume(), consume()]);
  const statuses = responses.map(({ status }) => status).sort();
  requireCondition(
    JSON.stringify(statuses) === JSON.stringify([201, 401]),
    "concurrent pairing consumption did not produce exactly one installation",
  );

  const successfulResponse = responses.find(({ status }) => status === 201);
  const installation = await successfulResponse.json();
  requireCondition(
    typeof installation.installationId === "string" &&
      typeof installation.token === "string",
    "concurrent pairing installation response mismatch",
  );
  popupArtifactSensitiveValues.push(installation.token);

  const persisted = await database.query(
    `SELECT pairing_grant."consumedAt", pairing_grant."installationId",
      count(installation."id")::integer AS "installationCount"
     FROM "ExtensionPairingGrant" AS pairing_grant
     LEFT JOIN "ExtensionInstallation" AS installation
       ON installation."id" = pairing_grant."installationId"
     WHERE pairing_grant."id" = $1
     GROUP BY pairing_grant."id"`,
    [grant.id],
  );
  const row = persisted.rows[0];
  requireCondition(
    persisted.rows.length === 1 &&
      row?.consumedAt instanceof Date &&
      row.installationId === installation.installationId &&
      row.installationCount === 1,
    "concurrent pairing did not persist exactly one consumed installation",
  );

  const revoked = await fetch(`${E2E_SERVER_ORIGIN}/api/extension/revoke`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer ${installation.token}`,
    },
  });
  requireCondition(
    revoked.status === 200,
    "concurrent pairing proof installation cleanup failed",
  );
}

async function expirePairingGrant(database, grantId) {
  const result = await database.query(
    'UPDATE "ExtensionPairingGrant" SET "expiresAt" = now() - interval \'1 second\' WHERE "id" = $1',
    [grantId],
  );
  requireCondition(result.rowCount === 1, "pairing grant expiry setup failed");
}

async function readInstallationConnection(popup) {
  const connection = await popup.call(async () => {
    const result = await chrome.storage.local.get(["connection"]);
    return result.connection ?? null;
  });
  requireCondition(
    typeof connection?.installationId === "string" &&
      typeof connection?.installationToken === "string" &&
      connection.invalidated === false,
    "installation credential was not persisted",
  );
  popupArtifactSensitiveValues.push(connection.installationToken);
  return connection;
}

async function requireInstallationScope(connection, origin) {
  const headers = {
    Origin: origin,
    Authorization: `Bearer ${connection.installationToken}`,
  };
  const verify = await fetch(`${E2E_SERVER_ORIGIN}/api/auth/verify`, {
    method: "POST",
    headers,
  });
  requireCondition(verify.status === 200, "installation verification failed");
  const profile = await fetch(`${E2E_SERVER_ORIGIN}/api/extension/profile`, {
    headers,
  });
  requireCondition(profile.status === 200, "minimal profile scope failed");
  const settings = await fetch(`${E2E_SERVER_ORIGIN}/api/settings`, { headers });
  requireCondition(settings.status === 403, "installation read settings");
}

async function requireTwoActiveInstallations(database, left, right) {
  const result = await database.query(
    'SELECT "id", "revokedAt" FROM "ExtensionInstallation" WHERE "id" = ANY($1::text[]) ORDER BY "id"',
    [[left.installationId, right.installationId]],
  );
  requireCondition(
    result.rows.length === 2 && result.rows.every((row) => row.revokedAt === null),
    "two active installations were not isolated",
  );
}

async function requireRevocationIsolation(database, revoked, active) {
  const result = await database.query(
    'SELECT "id", "revokedAt" FROM "ExtensionInstallation" WHERE "id" = ANY($1::text[])',
    [[revoked.installationId, active.installationId]],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  requireCondition(
    byId.get(revoked.installationId)?.revokedAt instanceof Date &&
      byId.get(active.installationId)?.revokedAt === null,
    "revocation crossed installation boundary",
  );
}

function rememberPopup(popup) {
  processState.popups.push(popup);
}

function forgetPopup(popup) {
  processState.popups = processState.popups.filter((candidate) => candidate !== popup);
}

async function verifyLiveDatabaseIdentity(database, expected) {
  const result = await database.query(
    "SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, current_schema() AS schema",
  );
  const row = result.rows[0];
  requireCondition(result.rows.length === 1, "database identity row mismatch");
  requireCondition(row?.database === expected.database, "database name mismatch");
  requireCondition(row?.address === expected.serverAddress, "database address mismatch");
  requireCondition(row?.port === expected.port, "database port mismatch");
  requireCondition(row?.schema === "public", "database schema mismatch");
}

async function resetDatabase(database) {
  await database.query(
    'TRUNCATE TABLE "ExtensionPairingGrant", "ExtensionInstallation", "Application", "Settings"',
  );
}

async function seedResume(database) {
  await database.query(
    'INSERT INTO "Settings" ("id", "llmProvider", "apiKey", "linkedinUrl", "githubUrl", "resumeText") VALUES ($1, $2, $3, $4, $5, $6)',
    [
      "singleton",
      "openai",
      "",
      "",
      "",
      "TypeScript and PostgreSQL engineer building observable secure services with product engineers.",
    ],
  );
}

function startServer(extensionOrigins) {
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_SECRET: E2E_ENCRYPTION_SECRET,
    APP_ACCESS_TOKEN: E2E_ACCESS_TOKEN,
    APP_BASE_URL: E2E_CONFIGURED_APP_ORIGIN,
    CORS_ALLOWED_ORIGINS:
      `${E2E_CONFIGURED_APP_ORIGIN},${extensionOrigins.join(",")}`,
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(root, "scripts/validate-startup-env-production.mjs"),
      join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      E2E_SERVER_HOST,
      "--port",
      String(E2E_SERVER_PORT),
    ],
    {
      cwd: root,
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  child.stderrText = "";
  child.stderr.on("data", (chunk) => {
    child.stderrText = `${child.stderrText}${chunk}`.slice(-4_096);
  });
  child.exitResult = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return child;
}

async function waitForServer(server, extensionOrigin) {
  const deadline = Date.now() + 30_000;
  let lastObservation = "no response";
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      server.exitResult.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), 100)),
    ]);
    if (exited) {
      if (process.env.EXTENSION_E2E_DEBUG === "1") {
        process.stderr.write(`${sanitizeDiagnostic(server.stderrText)}\n`);
      }
      throw new Error("local application exited before ready");
    }
    try {
      const response = await fetch(`${E2E_SERVER_ORIGIN}/api/auth/verify`, {
        method: "POST",
        headers: { Origin: extensionOrigin },
      });
      lastObservation = `HTTP ${response.status}`;
      if (response.status === 401) return;
    } catch (error) {
      lastObservation = error instanceof Error ? error.name : "fetch failure";
      // The loopback server is still starting.
    }
  }
  if (process.env.EXTENSION_E2E_DEBUG === "1") {
    process.stderr.write(`Readiness observation: ${lastObservation}\n`);
    process.stderr.write(`${sanitizeDiagnostic(server.stderrText)}\n`);
  }
  throw new Error("local application did not become ready");
}

async function grantOptionalHostPermission(context, extensionId) {
  const settingsPage = await context.newPage();
  try {
    await settingsPage.goto("chrome://extensions", {
      waitUntil: "domcontentloaded",
    });
    const granted = await settingsPage.evaluate(
      async ({ id, host }) => {
        if (typeof chrome.developerPrivate?.addHostPermission !== "function") {
          return false;
        }
        await chrome.developerPrivate.addHostPermission(id, host);
        return true;
      },
      { id: extensionId, host: permissionPattern },
    );
    requireCondition(granted, "optional host permission setup unavailable");
  } finally {
    await settingsPage.close();
  }
}

async function restartExtensionServiceWorker(
  browserCdp,
  context,
  jobPage,
  oldWorker,
  extensionId,
) {
  const serviceWorkerCdp = await context.newCDPSession(jobPage);
  const registrations = new Map();
  const versions = new Map();
  const onRegistrations = ({ registrations: updates = [] }) => {
    for (const registration of updates) {
      registrations.set(registration.registrationId, registration);
    }
  };
  const onVersions = ({ versions: updates = [] }) => {
    for (const version of updates) versions.set(version.versionId, version);
  };
  serviceWorkerCdp.on(
    "ServiceWorker.workerRegistrationUpdated",
    onRegistrations,
  );
  serviceWorkerCdp.on("ServiceWorker.workerVersionUpdated", onVersions);
  try {
    updateDiagnostic("old-state", "restart-old-state");
    await serviceWorkerCdp.send("ServiceWorker.enable");
    const oldState = await waitForValue(() => {
      try {
        return extensionServiceWorkerStateFromCdp(
          {
            registrations: [...registrations.values()],
            versions: [...versions.values()],
          },
          extensionId,
        );
      } catch {
        return null;
      }
    }, 10_000, "extension service worker registration was unavailable");
    requireCondition(
      oldWorker.url() === oldState.scriptURL,
      "Playwright worker did not match CDP version",
    );
    const initialTargets = await browserCdp.send("Target.getTargets");
    requireCondition(
      initialTargets.targetInfos.some(
        (target) =>
          target.targetId === oldState.targetId &&
          target.type === "service_worker" &&
          target.url === oldState.scriptURL,
      ),
      "old extension worker target was unavailable",
    );

    updateDiagnostic("wake-page", "restart-wake-page");
    const wakePage = await context.newPage();
    try {
      await wakePage.goto(extensionServiceWorkerWakeUrl(extensionId), {
        waitUntil: "domcontentloaded",
      });
      updateDiagnostic("runtime-connect", "restart-runtime-connect");
      const oldBootId = await connectExtensionWake(wakePage);
      requireCondition(
        typeof oldBootId === "string" && oldBootId.length > 0,
        "extension service worker initial wake acknowledgement was unavailable",
      );
      updateDiagnostic("stop-disappearance", "restart-stop-disappearance");
      await serviceWorkerCdp.send("ServiceWorker.stopWorker", {
        versionId: oldState.versionId,
      });
      await waitForValue(async () => {
        const targets = await browserCdp.send("Target.getTargets");
        return targets.targetInfos.some(
          (target) => target.targetId === oldState.targetId,
        )
          ? null
          : true;
      }, 10_000, "old extension worker target remained after stop");

      updateDiagnostic("runtime-connect", "restart-runtime-connect");
      const newBootId = await connectExtensionWake(wakePage);
      requireCondition(
        typeof newBootId === "string" &&
          newBootId.length > 0 &&
          newBootId !== oldBootId,
        "extension service worker restart acknowledgement was unchanged",
      );
      updateDiagnostic("new-target", "restart-new-target");
      const newTarget = await waitForValue(async () => {
        const targets = await browserCdp.send("Target.getTargets");
        return targets.targetInfos.find(
          (target) =>
            target.type === "service_worker" &&
            target.url === oldState.scriptURL,
        );
      }, 10_000, "new extension worker target was unavailable");
      requireCondition(
        newTarget.targetId !== oldState.targetId ||
          newBootId !== oldBootId,
        "new extension worker identity matched old worker",
      );
      requireCondition(
        newTarget.url === oldState.scriptURL,
        "new extension worker script URL did not match old worker",
      );
      const { sessionId } = await browserCdp.send("Target.attachToTarget", {
        targetId: newTarget.targetId,
        flatten: false,
      });
      const newWorkerCdp = new CdpPopup(
        browserCdp,
        sessionId,
        newTarget.targetId,
      );
      updateDiagnostic("runtime", "restart-runtime");
      const runtimeUrl = await newWorkerCdp.call(
        () => globalThis.location.href,
      );
      requireCondition(
        runtimeUrl === oldState.scriptURL,
        "new extension worker runtime was unavailable",
      );
      updateDiagnostic("wake-page-close", "restart-wake-page-close");
      await wakePage.close();
      requireCondition(
        wakePage.isClosed(),
        "extension service worker wake page remained open",
      );
      return {
        cdp: newWorkerCdp,
        sessionId,
        targetId: newTarget.targetId,
        url: () => newTarget.url,
      };
    } finally {
      if (!wakePage.isClosed()) await wakePage.close().catch(() => undefined);
    }
  } finally {
    serviceWorkerCdp.off(
      "ServiceWorker.workerRegistrationUpdated",
      onRegistrations,
    );
    serviceWorkerCdp.off("ServiceWorker.workerVersionUpdated", onVersions);
    await serviceWorkerCdp.send("ServiceWorker.disable").catch(() => undefined);
    await serviceWorkerCdp.detach().catch(() => undefined);
  }
}

async function connectExtensionWake(page) {
  return page.evaluate(
    async ({ channel, message, acknowledgement }) => {
      const port = chrome.runtime.connect({ name: channel });
      globalThis.__jobtrackerE2EWakePort = port;
      return new Promise((resolveWake) => {
        const timeout = setTimeout(() => resolveWake(null), 5_000);
        port.onMessage.addListener((response) => {
          if (
            response?.type !== acknowledgement ||
            typeof response.bootId !== "string" ||
            response.bootId.length === 0
          ) {
            return;
          }
          clearTimeout(timeout);
          resolveWake(response.bootId);
        });
        port.postMessage({ type: message });
      });
    },
    {
      channel: EXTENSION_E2E_WAKE_CHANNEL,
      message: EXTENSION_E2E_WAKE_MESSAGE,
      acknowledgement: EXTENSION_E2E_WAKE_ACK,
    },
  );
}

async function waitForValue(readValue, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(message);
}

async function openActionPopup(browserCdp, worker, jobPage, extensionOrigin) {
  await jobPage.bringToFront();
  const initialTargets = await browserCdp.send("Target.getTargets");
  const workerTarget = initialTargets.targetInfos.find(
    (target) =>
      target.type === "service_worker" &&
      target.url === worker.url() &&
      (!worker.targetId || target.targetId === worker.targetId),
  );
  requireCondition(workerTarget, "extension worker CDP target was unavailable");
  const heldWorkerCdp = worker.cdp;
  const heldWorkerSessionId = worker.sessionId;
  if (heldWorkerCdp) {
    worker.cdp = null;
    worker.sessionId = null;
  }
  const workerAttachment = heldWorkerCdp
    ? { sessionId: heldWorkerSessionId, cdp: heldWorkerCdp }
    : await browserCdp
        .send("Target.attachToTarget", {
          targetId: workerTarget.targetId,
          flatten: false,
        })
        .then(({ sessionId }) => ({
          sessionId,
          cdp: new CdpPopup(browserCdp, sessionId, workerTarget.targetId),
        }));
  try {
    await workerAttachment.cdp.call(async () => {
      await chrome.action.openPopup();
    }, [], true);
  } finally {
    await browserCdp.send("Target.detachFromTarget", {
      sessionId: workerAttachment.sessionId,
    });
  }
  const expectedUrl = `${extensionOrigin}/popup.html`;
  const deadline = Date.now() + 10_000;
  let popupTarget;
  while (Date.now() < deadline) {
    const targets = await browserCdp.send("Target.getTargets");
    popupTarget = targets.targetInfos.find(
      (target) => target.type === "page" && target.url === expectedUrl,
    );
    if (popupTarget) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  requireCondition(popupTarget, "action popup CDP target was unavailable");
  const { sessionId } = await browserCdp.send("Target.attachToTarget", {
    targetId: popupTarget.targetId,
    flatten: false,
  });
  const popup = new CdpPopup(browserCdp, sessionId, popupTarget.targetId);
  await popup.waitForVisible("#connectionStatus", 10_000);
  return popup;
}

class CdpPopup {
  constructor(browserCdp, sessionId, targetId) {
    this.browserCdp = browserCdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.messageId = 0;
    this.pending = new Map();
    this.closed = false;
    this.browserCdp.on(
      "Target.receivedMessageFromTarget",
      ({ sessionId: receivedSessionId, message }) => {
        if (receivedSessionId !== this.sessionId) return;
        const response = JSON.parse(message);
        const resolveResponse = this.pending.get(response.id);
        if (resolveResponse) resolveResponse(response);
      },
    );
    this.browserCdp.on(
      "Target.detachedFromTarget",
      ({ sessionId: detachedSessionId }) => {
        if (detachedSessionId === this.sessionId) this.closed = true;
      },
    );
  }

  async send(method, params = {}) {
    requireCondition(!this.closed, "action popup closed unexpectedly");
    this.messageId += 1;
    const id = this.messageId;
    const responsePromise = new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error("action popup CDP response timed out"));
      }, 10_000);
      this.pending.set(id, (response) => {
        clearTimeout(timeout);
        resolveResponse(response);
      });
    });
    await this.browserCdp.send("Target.sendMessageToTarget", {
      sessionId: this.sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    const response = await responsePromise;
    this.pending.delete(id);
    if (response.error) throw new Error("action popup CDP command failed");
    return response.result;
  }

  async call(functionToCall, args = [], userGesture = false) {
    const expression = `(${functionToCall.toString()})(...${JSON.stringify(args)})`;
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (response.exceptionDetails) {
      if (process.env.EXTENSION_E2E_DEBUG === "1") {
        const description =
          response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "unknown CDP exception";
        process.stderr.write(
          `CDP evaluation exception: ${sanitizeDiagnostic(description)}\n`,
        );
      }
      throw new Error("action popup evaluation failed");
    }
    return response.result?.value;
  }

  async exists(selector) {
    return this.call(
      (value) => document.querySelector(value) !== null,
      [selector],
    );
  }

  async value(selector) {
    return this.call((value) => {
      const element = document.querySelector(value);
      return element && "value" in element ? element.value : null;
    }, [selector]);
  }

  async text(selector) {
    return this.call(
      (value) => document.querySelector(value)?.textContent ?? null,
      [selector],
    );
  }

  async fill(selector, value) {
    const filled = await this.call((target, inputValue) => {
      const element = document.querySelector(target);
      if (!element || !("value" in element)) return false;
      element.value = inputValue;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, [selector, value]);
    requireCondition(filled, "action popup input was unavailable");
  }

  async click(selector) {
    const clicked = await this.call((value) => {
      const element = document.querySelector(value);
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      element.click();
      return true;
    }, [selector], true);
    requireCondition(clicked, "action popup control was unavailable");
  }

  async waitForVisible(selector, timeout) {
    await this.waitFor(async () =>
      this.call((value) => {
        const element = document.querySelector(value);
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      }, [selector]), timeout, "action popup element did not become visible");
  }

  async waitForText(selector, expected, timeout) {
    await this.waitFor(async () =>
      this.call((target, text) =>
        document.querySelector(target)?.textContent?.includes(text) === true,
      [selector, expected]), timeout, "action popup status did not update");
  }

  async waitFor(predicate, timeout, message) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error(message);
  }

  async redact() {
    return this.call(redactPopupDocument);
  }

  async screenshot(path) {
    const response = await this.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await writeFile(path, Buffer.from(response.data, "base64"), {
      mode: 0o600,
    });
  }

  async close() {
    if (this.closed) return;
    await this.browserCdp.send("Target.closeTarget", {
      targetId: this.targetId,
    });
    this.closed = true;
  }
}

async function waitForPopupExtraction(popup) {
  await popup.waitForVisible("#form", 10_000);
  requireCondition(await popup.exists("#jobTitle"), "job form did not attach");
}

async function connectFromPopup(popup, token) {
  await popup.fill("#serverUrl", E2E_SERVER_ORIGIN);
  await popup.fill("#accessToken", token);
  await popup.click("#connectBtn");
}

async function waitForText(popup, selector, text) {
  await popup.waitForText(selector, text, 15_000);
}

async function requireEmptyTokenInput(popup) {
  requireCondition(
    (await popup.value("#accessToken")) === "",
    "token input was not cleared",
  );
}

async function requireCredentialAndPermissionState(
  popup,
  { hasCredential, hasPermission },
) {
  const state = await popup.call(async (pattern) => {
    const storage = await chrome.storage.local.get([
      "connection",
      "serverUrl",
      "accessToken",
      "installationToken",
    ]);
    return {
      hasCredential: Boolean(
        storage.connection?.installationToken || storage.installationToken,
      ),
      hasLegacyToken:
        Object.hasOwn(storage, "accessToken") ||
        typeof storage.connection?.accessToken === "string",
      hasPermission: await chrome.permissions.contains({ origins: [pattern] }),
    };
  }, [permissionPattern]);
  requireCondition(
    state.hasCredential === hasCredential,
    "credential persistence state mismatch",
  );
  requireCondition(!state.hasLegacyToken, "legacy token key remained");
  requireCondition(
    state.hasPermission === hasPermission,
    "host permission state mismatch",
  );
}

async function assertExtractedApplication(popup) {
  const extracted = {
    url: await popup.value("#jobUrl"),
    jobTitle: await popup.value("#jobTitle"),
    company: await popup.value("#company"),
    location: await popup.value("#location"),
    jobType: await popup.value("#jobType"),
    salary: await popup.value("#salary"),
    description: await popup.value("#description"),
  };
  for (const [field, expected] of Object.entries(LEVER_EXPECTED_APPLICATION)) {
    requireCondition(extracted[field] === expected, `${field} extraction mismatch`);
  }
}

async function assertDatabaseApplication(database) {
  const result = await database.query(
    'SELECT "url", "jobTitle", "company", "location", "jobType", "salary", "description" FROM "Application"',
  );
  requireCondition(result.rows.length === 1, "saved application count mismatch");
  const row = result.rows[0];
  for (const [field, expected] of Object.entries(LEVER_EXPECTED_APPLICATION)) {
    requireCondition(row?.[field] === expected, `${field} database mismatch`);
  }
}

async function runCommand(command, args, environment) {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) throw new Error("extension E2E child command failed");
}

async function writeSanitizedFailureArtifacts(error) {
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 }).catch(
    () => undefined,
  );
  const popup = processState.popups.at(-1);
  if (popup && !popup.closed) {
    try {
      const snapshot = await popup.redact();
      assertSanitizedPopupSnapshot(snapshot, popupArtifactSensitiveValues);
      await popup.screenshot(join(artifactsDirectory, "popup-redacted.png"));
    } catch {
      // Never capture a screenshot unless the generic-only DOM is proven safe.
    }
  }
  try {
    await writeFile(
      join(artifactsDirectory, "diagnostics.json"),
      `${JSON.stringify(
        {
          step: processState.step,
          checkpoint: processState.checkpoint,
          failureCode: processState.failureCode,
          browserVersion: processState.browserVersion,
          extensionIds: processState.extensionIds,
          failureType: error instanceof Error ? error.name : "UnknownError",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Artifact creation must never obscure the original failure.
  }
}

function updateDiagnostic(checkpoint, failureCode) {
  processState.checkpoint = checkpoint;
  processState.failureCode = failureCode;
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const popup of processState.popups) {
      try {
        await popup.close();
      } catch {
        // Continue closing the browser contexts.
      }
    }
    processState.popups = [];
    for (const context of processState.contexts) {
      try {
        await context.close();
      } catch {
        // Continue cleaning remaining resources.
      }
    }
    processState.contexts = [];
    processState.browserCdps = [];
    if (processState.server && processState.server.exitCode === null) {
      processState.server.kill("SIGTERM");
      const stopped = await Promise.race([
        processState.server.exitResult.then(() => true),
        new Promise((resolveWait) =>
          setTimeout(() => resolveWait(false), 5_000),
        ),
      ]);
      if (!stopped) processState.server.kill("SIGKILL");
    }
    processState.server = null;
    if (processState.database) {
      try {
        await resetDatabase(processState.database);
      } catch {
        // Migrations may not have completed, but the target was verified first.
      }
      try {
        await processState.database.end();
      } catch {
        // Continue removing the isolated profile.
      }
      processState.database = null;
    }
    if (processState.profileDirectory) {
      const workspace = assertExtensionE2EWorkspacePath(
        processState.profileDirectory,
        tmpdir(),
      );
      await rm(workspace, { recursive: true, force: true });
      processState.profileDirectory = null;
    }
  })();
  return cleanupPromise;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replaceAll(E2E_ACCESS_TOKEN, "[redacted-access-token]")
    .replaceAll(E2E_INVALID_ACCESS_TOKEN, "[redacted-invalid-token]")
    .replaceAll(E2E_ENCRYPTION_SECRET, "[redacted-encryption-secret]")
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/giu, "[redacted-database-url]")
    .replace(/Authorization:\s*Bearer\s+\S+/giu, "Authorization: [redacted]");
}

try {
  await run();
  process.stdout.write("Extension E2E passed.\n");
} catch (error) {
  await writeSanitizedFailureArtifacts(error);
  if (process.env.EXTENSION_E2E_DEBUG === "1") {
    process.stderr.write(
      `${sanitizeDiagnostic(error instanceof Error ? error.stack : error)}\n`,
    );
  }
  process.stderr.write(`Extension E2E failed during ${processState.step}.\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
