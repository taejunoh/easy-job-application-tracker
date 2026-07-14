import { spawn } from "node:child_process";
import {
  access,
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
  assertSafeExtensionE2EEnvironment,
  buildE2EManifest,
  extensionIdentityFromWorkerUrl,
} from "./extension-e2e-support.mjs";

const { Client } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(root, ".artifacts/extension-e2e");
const permissionPattern = `${E2E_SERVER_ORIGIN}/*`;
const processState = {
  browserVersion: "unknown",
  browserCdp: null,
  context: null,
  database: null,
  extensionId: "unknown",
  profileDirectory: null,
  popup: null,
  server: null,
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
  const workspace = await mkdtemp(
    join(tmpdir(), "jobtracker-extension-e2e-"),
  );
  processState.profileDirectory = workspace;
  const extensionDirectory = join(workspace, "extension");
  const browserProfile = join(workspace, "browser-profile");
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

  processState.step = "Chromium launch";
  const context = await chromium.launchPersistentContext(browserProfile, {
    channel: "chromium",
    headless: process.env.EXTENSION_E2E_HEADED !== "1",
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  processState.context = context;
  processState.browserVersion = context.browser()?.version() ?? "unknown";
  const browserCdp = await context.browser().newBrowserCDPSession();
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  processState.browserCdp = browserCdp;

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  }
  const identity = extensionIdentityFromWorkerUrl(worker.url());
  processState.extensionId = identity.id;

  processState.step = "local application startup";
  processState.server = startServer(identity.origin);
  await waitForServer(processState.server, identity.origin);

  processState.step = "deterministic job fixture";
  await context.route(LEVER_FIXTURE_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: LEVER_FIXTURE_HTML,
    });
  });
  const jobPage = await context.newPage();
  await jobPage.goto(LEVER_FIXTURE_URL, { waitUntil: "domcontentloaded" });

  processState.step = "optional host permission test setup";
  await grantOptionalHostPermission(context, identity.id);

  processState.step = "disconnected popup";
  let popup = await openActionPopup(
    browserCdp,
    worker,
    jobPage,
    identity.origin,
  );
  processState.popup = popup;
  await waitForPopupExtraction(popup);
  await waitForText(popup, "#connectionStatus", "Disconnected");

  processState.step = "invalid token rejection";
  await connectFromPopup(popup, E2E_INVALID_ACCESS_TOKEN);
  await waitForText(popup, "#connectionStatus", "not accepted");
  await requireEmptyTokenInput(popup);
  await requireCredentialAndPermissionState(popup, {
    hasCredential: false,
    hasPermission: false,
  });

  processState.step = "valid extension pairing";
  await popup.close();
  processState.popup = null;
  await grantOptionalHostPermission(context, identity.id);
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  processState.popup = popup;
  await waitForText(popup, "#connectionStatus", "Disconnected");
  await connectFromPopup(popup, E2E_ACCESS_TOKEN);
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

  processState.step = "action popup reopen and connection restoration";
  await popup.close();
  processState.popup = null;
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  processState.popup = popup;
  await waitForText(popup, "#connectionStatus", "Connected to");
  await requireEmptyTokenInput(popup);

  processState.step = "user disconnect cleanup";
  await popup.click("#disconnectBtn");
  await waitForText(popup, "#connectionStatus", "Disconnected");
  await requireCredentialAndPermissionState(popup, {
    hasCredential: false,
    hasPermission: false,
  });

  processState.step = "reconnect before forced unauthorized response";
  await popup.close();
  processState.popup = null;
  await grantOptionalHostPermission(context, identity.id);
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  processState.popup = popup;
  await waitForText(popup, "#connectionStatus", "Disconnected");
  await connectFromPopup(popup, E2E_ACCESS_TOKEN);
  await waitForText(popup, "#connectionStatus", "Connected to");
  await requireCredentialAndPermissionState(popup, {
    hasCredential: true,
    hasPermission: true,
  });

  processState.step = "stored credential 401 invalidation";
  await popup.call(
    async (origin, invalidToken) => {
      await chrome.storage.local.set({
        connection: {
          serverUrl: origin,
          accessToken: invalidToken,
          invalidated: false,
        },
      });
    },
    [E2E_SERVER_ORIGIN, E2E_INVALID_ACCESS_TOKEN],
  );
  await popup.close();
  processState.popup = null;
  popup = await openActionPopup(browserCdp, worker, jobPage, identity.origin);
  processState.popup = popup;
  await waitForText(popup, "#connectionStatus", "Connection expired");
  await requireCredentialAndPermissionState(popup, {
    hasCredential: false,
    hasPermission: false,
  });
  await popup.close();
  processState.popup = null;

  processState.step = "final database cleanup verification";
  await resetDatabase(database);
  const remaining = await database.query(
    'SELECT count(*)::integer AS count FROM "Application"',
  );
  requireCondition(remaining.rows[0]?.count === 0, "test application remained");
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
  await database.query('TRUNCATE TABLE "Application", "Settings"');
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

function startServer(extensionOrigin) {
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_SECRET: E2E_ENCRYPTION_SECRET,
    APP_ACCESS_TOKEN: E2E_ACCESS_TOKEN,
    APP_BASE_URL: E2E_CONFIGURED_APP_ORIGIN,
    CORS_ALLOWED_ORIGINS: `${E2E_CONFIGURED_APP_ORIGIN},${extensionOrigin}`,
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

async function openActionPopup(browserCdp, worker, jobPage, extensionOrigin) {
  await jobPage.bringToFront();
  const initialTargets = await browserCdp.send("Target.getTargets");
  const workerTarget = initialTargets.targetInfos.find(
    (target) => target.type === "service_worker" && target.url === worker.url(),
  );
  requireCondition(workerTarget, "extension worker CDP target was unavailable");
  const workerAttachment = await browserCdp.send("Target.attachToTarget", {
    targetId: workerTarget.targetId,
    flatten: false,
  });
  const workerCdp = new CdpPopup(
    browserCdp,
    workerAttachment.sessionId,
    workerTarget.targetId,
  );
  await workerCdp.call(async () => {
    await chrome.action.openPopup();
  }, [], true);
  await browserCdp.send("Target.detachFromTarget", {
    sessionId: workerAttachment.sessionId,
  });
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
    await this.call(() => {
      for (const id of [
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
        if (element && "value" in element) element.value = "";
      }
      const status = document.getElementById("statusMsg");
      if (status) status.textContent = "E2E failure details redacted";
    });
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
    ]);
    return {
      hasCredential: Boolean(
        storage.connection?.accessToken || storage.accessToken,
      ),
      hasLegacyToken: Object.hasOwn(storage, "accessToken"),
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
  try {
    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    const popup = processState.popup;
    if (popup && !popup.closed) {
      await popup.redact();
      await popup.screenshot(
        join(artifactsDirectory, "popup-redacted.png"),
      );
    }
    await writeFile(
      join(artifactsDirectory, "diagnostics.json"),
      `${JSON.stringify(
        {
          step: processState.step,
          browserVersion: processState.browserVersion,
          extensionId: processState.extensionId,
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

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (processState.popup) {
      try {
        await processState.popup.close();
      } catch {
        // Continue closing the browser context.
      }
      processState.popup = null;
    }
    if (processState.context) {
      try {
        await processState.context.close();
      } catch {
        // Continue cleaning remaining resources.
      }
      processState.context = null;
      processState.browserCdp = null;
    }
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
      await rm(processState.profileDirectory, { recursive: true, force: true });
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
