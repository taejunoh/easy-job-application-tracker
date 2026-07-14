const formEl = document.getElementById("form");
const extractingEl = document.getElementById("extracting");
const noPageEl = document.getElementById("noPage");
const statusMsg = document.getElementById("statusMsg");
const saveBtn = document.getElementById("saveBtn");
const refreshBtn = document.getElementById("refreshBtn");
const serverUrlInput = document.getElementById("serverUrl");
const accessTokenInput = document.getElementById("accessToken");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const connectionStatus = document.getElementById("connectionStatus");
const openTracker = document.getElementById("openTracker");

let currentConnection = null;
let connectionGeneration = 0;
let credentialMutationQueue = Promise.resolve();

let trustedStoragePromise;
try {
  trustedStoragePromise = Promise.resolve(
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ).then(
    () => true,
    () => false
  );
} catch {
  trustedStoragePromise = Promise.resolve(false);
}

function normalizeServerOrigin(value) {
  const input = String(value).trim();
  if (!/^https?:\/\//i.test(input) || input.includes("\\")) {
    throw new Error("Enter a valid server URL.");
  }

  const authorityStart = input.indexOf("://") + 3;
  const suffixStart = input.slice(authorityStart).search(/[/?#]/);
  const suffix = suffixStart === -1
    ? ""
    : input.slice(authorityStart + suffixStart);
  const authority = suffixStart === -1
    ? input.slice(authorityStart)
    : input.slice(authorityStart, authorityStart + suffixStart);
  if (authority.includes("@")) {
    throw new Error("The server URL cannot include credentials.");
  }
  if (suffix !== "" && suffix !== "/") {
    throw new Error("Enter only the server origin, without a path or query.");
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Enter a valid server URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The server URL must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The server URL cannot include credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Enter only the server origin, without a path or query.");
  }

  const isLoopback = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error("HTTPS is required outside localhost development.");
  }

  return parsed.origin;
}

function permissionPattern(origin) {
  const parsed = new URL(origin);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${parsed.hostname}:${port}/*`;
}

function setConnectionStatus(message, type = "info", loading = false) {
  connectionStatus.textContent = message;
  connectionStatus.className = `connection-status ${type}`;
  connectBtn.disabled = loading;
  connectBtn.textContent = loading ? "Connecting..." : "Connect";
  disconnectBtn.disabled = loading || !currentConnection;
}

function clearApplicationTarget() {
  delete openTracker.dataset.appUrl;
  openTracker.textContent = "Open tracker";
}

function replaceCurrentConnection(connection) {
  connectionGeneration += 1;
  currentConnection = connection
    ? { ...connection, generation: connectionGeneration }
    : null;
}

function mutateCredentials(operation) {
  const mutation = credentialMutationQueue.then(operation, operation);
  credentialMutationQueue = mutation.then(
    () => undefined,
    () => undefined
  );
  return mutation;
}

async function requireTrustedStorage() {
  if (await trustedStoragePromise) return;
  replaceCurrentConnection(null);
  clearApplicationTarget();
  setConnectionStatus(
    "Secure credential storage is unavailable. JobTracker requires Chrome 102 or newer.",
    "error"
  );
  throw new Error("Secure extension storage is unavailable.");
}

function getStoredConnection(result) {
  const record = result?.connection && typeof result.connection === "object"
    ? result.connection
    : null;
  if (record) {
    return {
      serverUrl: record.serverUrl,
      accessToken: record.invalidated ? undefined : record.accessToken,
      invalidated: record.invalidated === true,
      legacy: false,
    };
  }
  return {
    serverUrl: result?.serverUrl,
    accessToken: result?.accessToken,
    invalidated: false,
    legacy: true,
  };
}

async function storeConnectionRecord(record) {
  await chrome.storage.local.set({ connection: record });
  try {
    await chrome.storage.local.remove(["serverUrl", "accessToken"]);
    return true;
  } catch {
    return false;
  }
}

function restoreConnection(result) {
  replaceCurrentConnection(null);
  accessTokenInput.value = "";
  const stored = getStoredConnection(result);

  if (typeof stored.serverUrl === "string" && stored.serverUrl) {
    serverUrlInput.value = stored.serverUrl;
  }

  if (!stored.invalidated && typeof stored.accessToken === "string" &&
      stored.accessToken && typeof stored.serverUrl === "string") {
    try {
      const origin = normalizeServerOrigin(stored.serverUrl);
      replaceCurrentConnection({
        serverUrl: origin,
        accessToken: stored.accessToken,
      });
      serverUrlInput.value = origin;
      setConnectionStatus(`Connected to ${origin}`, "success");
      return;
    } catch {
      // Preserve an invalid legacy URL as a draft, but never use its token.
    }
  }

  setConnectionStatus(
    "Disconnected — enter an access token to connect.",
    "info"
  );
}

async function removePermission(pattern) {
  try {
    return await chrome.permissions.remove({ origins: [pattern] }) === true;
  } catch {
    return false;
  }
}

async function connectServer() {
  const token = accessTokenInput.value;
  let origin;

  try {
    origin = normalizeServerOrigin(serverUrlInput.value);
  } catch (error) {
    accessTokenInput.value = "";
    setConnectionStatus(error.message, "error");
    serverUrlInput.focus();
    return;
  }

  if (!token) {
    setConnectionStatus("Enter an access token to connect.", "error");
    accessTokenInput.focus();
    return;
  }

  const pattern = permissionPattern(origin);
  let priorPermissionState = "unknown";
  let granted = false;
  let stored = false;
  let phase = "permission";

  setConnectionStatus("Requesting access to the server...", "info", true);

  try {
    // Start both calls directly from the Connect click. request() therefore
    // retains the user gesture, while contains() tells us whether a failed
    // attempt introduced a permission that should be cleaned up.
    const priorPermissionPromise = Promise.resolve(
      chrome.permissions.contains({ origins: [pattern] })
    ).then(
      (contains) => contains === true,
      () => "unknown"
    );
    const requestPromise = chrome.permissions.request({ origins: [pattern] });
    [priorPermissionState, granted] = await Promise.all([
      priorPermissionPromise,
      requestPromise,
    ]);

    if (!granted) {
      setConnectionStatus(
        "Server access was not granted. The previous connection is unchanged.",
        "error"
      );
      return;
    }

    phase = "storage-access";
    await requireTrustedStorage();
    phase = "verify";
    setConnectionStatus("Verifying access token...", "info", true);
    const response = await fetch(`${origin}/api/auth/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      throw new Error("The access token was not accepted.");
    }
    if (response.status === 403) {
      throw new Error("This extension is not allowed by the server.");
    }
    if (!response.ok) {
      throw new Error(`The server could not verify this connection (${response.status}).`);
    }

    phase = "storage";
    const mutation = await mutateCredentials(async () => {
      await requireTrustedStorage();
      const previous = currentConnection;
      const legacyClean = await storeConnectionRecord({
        serverUrl: origin,
        accessToken: token,
        invalidated: false,
      });
      stored = true;
      replaceCurrentConnection({ serverUrl: origin, accessToken: token });
      clearApplicationTarget();
      serverUrlInput.value = origin;
      return { legacyClean, previous };
    });

    let permissionClean = true;
    if (mutation.previous && mutation.previous.serverUrl !== origin) {
      permissionClean = await removePermission(
        permissionPattern(mutation.previous.serverUrl)
      );
    }
    const warning = !permissionClean
      ? " Old host access could not be removed."
      : !mutation.legacyClean
        ? " Legacy credential cleanup failed."
        : "";
    setConnectionStatus(`Connected to ${origin}.${warning}`, warning ? "info" : "success");
  } catch (error) {
    let permissionClean = true;
    if (granted && priorPermissionState === false && !stored) {
      permissionClean = await removePermission(pattern);
    }

    if (phase === "storage-access") {
      setConnectionStatus(
        "Secure credential storage is unavailable. JobTracker requires Chrome 102 or newer.",
        "error"
      );
    } else if (phase === "permission") {
      setConnectionStatus(
        "Server access was not granted. The previous connection is unchanged.",
        "error"
      );
    } else if (phase === "storage") {
      setConnectionStatus(
        "Could not save the connection. The previous connection is unchanged.",
        "error"
      );
    } else if (error?.message?.startsWith("The access token") ||
               error?.message?.includes("not allowed") ||
               error?.message?.startsWith("The server could not verify")) {
      setConnectionStatus(error.message, "error");
    } else {
      setConnectionStatus(
        "Could not reach the server. Check its URL and CORS configuration.",
        "error"
      );
    }
    if (!permissionClean) {
      setConnectionStatus(
        `${connectionStatus.textContent} Host access could not be removed.`,
        "error"
      );
    }
  } finally {
    accessTokenInput.value = "";
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
  }
}

async function disconnectServer() {
  await mutateCredentials(async () => {
    const connection = currentConnection;
    let origin = connection?.serverUrl;
    if (!origin) {
      try {
        origin = normalizeServerOrigin(serverUrlInput.value);
      } catch {
        origin = "";
      }
    }

    replaceCurrentConnection(null);
    clearApplicationTarget();
    accessTokenInput.value = "";

    let storageClean = true;
    try {
      await requireTrustedStorage();
      if (origin) {
        storageClean = await storeConnectionRecord({
          serverUrl: origin,
          invalidated: true,
        });
      }
    } catch {
      storageClean = false;
    }

    const permissionClean = origin
      ? await removePermission(permissionPattern(origin))
      : true;
    const warnings = [
      !storageClean ? "Credential storage could not be updated." : "",
      !permissionClean ? "Host access could not be removed." : "",
    ].filter(Boolean).join(" ");
    setConnectionStatus(
      warnings || "Disconnected. Enter an access token to reconnect.",
      warnings ? "error" : "info"
    );
  });
}

function sameConnection(left, right) {
  return Boolean(left && right &&
    left.generation === right.generation &&
    left.serverUrl === right.serverUrl &&
    left.accessToken === right.accessToken);
}

async function invalidateUnauthorizedConnection(connection) {
  return mutateCredentials(async () => {
    if (!sameConnection(currentConnection, connection)) return false;

    replaceCurrentConnection(null);
    clearApplicationTarget();
    accessTokenInput.value = "";

    let storageClean = true;
    try {
      await requireTrustedStorage();
      await storeConnectionRecord({
        serverUrl: connection.serverUrl,
        invalidated: true,
      });
    } catch {
      storageClean = false;
      try {
        await chrome.storage.local.remove(["connection", "accessToken"]);
      } catch {
        // Startup verification prevents a stale record from being trusted.
      }
    }

    const permissionClean = await removePermission(
      permissionPattern(connection.serverUrl)
    );
    const warnings = [
      !storageClean ? "Credential storage could not be updated." : "",
      !permissionClean ? "Host access could not be removed." : "",
    ].filter(Boolean).join(" ");
    setConnectionStatus(
      warnings || "Connection expired. Enter the access token to reconnect.",
      "error"
    );
    return true;
  });
}

async function authenticatedRequest(path, init = {}) {
  await requireTrustedStorage();
  if (!currentConnection) {
    throw new Error("Connect this extension to a server before using its API.");
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("API paths must be relative to the connected server.");
  }

  const connection = { ...currentConnection };
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${connection.accessToken}`);
  const response = await fetch(`${connection.serverUrl}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    await invalidateUnauthorizedConnection(connection);
    throw new Error("Connection expired. Reconnect to the server.");
  }

  return { connection, response };
}

async function apiFetch(path, init = {}) {
  return (await authenticatedRequest(path, init)).response;
}

function showStatus(message, type) {
  statusMsg.textContent = message;
  statusMsg.className = `status ${type}`;
  statusMsg.style.display = "block";
}

function populateForm(data, tabUrl) {
  document.getElementById("jobTitle").value = data.jobTitle || "";
  document.getElementById("company").value = data.company || "";
  document.getElementById("location").value = data.location || "";
  document.getElementById("description").value = data.description || "";
  document.getElementById("salary").value = data.salary || "";
  document.getElementById("jobType").value = data.jobType || "";
  document.getElementById("jobUrl").value = data.url || tabUrl || "";

  extractingEl.style.display = "none";
  formEl.style.display = "block";

  if (!data.jobTitle && !data.company) {
    showStatus("Could not auto-detect job data. Please fill in manually.", "info");
  } else if (data.warning) {
    showStatus(data.warning, "info");
  }

  // Always show analyze button
  const analyzeBtn = document.getElementById("analyzeBtn");
  if (analyzeBtn) {
    analyzeBtn.style.display = "block";
  }
}

async function runKeywordAnalysis() {
  let description = document.getElementById("description").value.trim();

  // If no description extracted, try to get it from the page
  if (!description) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const response = await sendMessageWithRetry(tab.id, { action: "extractJob" });
        if (response?.description) {
          description = response.description;
          document.getElementById("description").value = description;
        }
      }
    } catch {
      // ignore
    }
  }

  if (!description) {
    showStatus("No job description found on this page.", "info");
    return;
  }

  const section = document.getElementById("analysisSection");
  const prompt = document.getElementById("analysisPrompt");
  const analyzeBtn = document.getElementById("analyzeBtn");

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";

  try {
    const res = await apiFetch("/api/keyword-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    if (!res.ok) {
      analyzeBtn.textContent = "Analyze Keywords";
      analyzeBtn.disabled = false;
      return;
    }

    const data = await res.json();

    if (data.error === "no_resume") {
      prompt.innerHTML = 'Add your resume in <a href="#" id="openSettings">Settings</a> to see keyword match.';
      prompt.style.display = "block";
      analyzeBtn.style.display = "none";
      document.getElementById("openSettings")?.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: `${currentConnection.serverUrl}/settings` });
      });
      return;
    }

    if (!data.totalJobKeywords || data.totalJobKeywords === 0) {
      analyzeBtn.textContent = "No keywords found";
      return;
    }

    // Hide button, show results
    analyzeBtn.style.display = "none";

    // Show analysis
    const pct = data.matchPercentage;
    const badge = document.getElementById("analysisBadge");
    const fill = document.getElementById("progressFill");

    badge.textContent = `${pct}%`;
    badge.className = `analysis-badge ${pct >= 70 ? "badge-green" : pct >= 40 ? "badge-yellow" : "badge-red"}`;
    fill.style.width = `${pct}%`;
    fill.className = `progress-fill ${pct >= 70 ? "fill-green" : pct >= 40 ? "fill-yellow" : "fill-red"}`;

    document.getElementById("analysisSummary").textContent =
      `${data.matchedKeywords.length} of ${data.totalJobKeywords} keywords matched`;

    // Matched pills
    const matchedPills = document.getElementById("matchedPills");
    const matchedSection = document.getElementById("matchedSection");
    matchedPills.innerHTML = "";
    if (data.matchedKeywords.length > 0) {
      matchedSection.style.display = "block";
      for (const k of data.matchedKeywords) {
        const pill = document.createElement("span");
        pill.className = "pill pill-green";
        pill.textContent = k.keyword;
        matchedPills.appendChild(pill);
      }
    }

    // Missing pills
    const missingPills = document.getElementById("missingPills");
    const missingSection = document.getElementById("missingSection");
    missingPills.innerHTML = "";
    if (data.missingKeywords.length > 0) {
      missingSection.style.display = "block";
      for (const k of data.missingKeywords) {
        const pill = document.createElement("span");
        pill.className = "pill pill-red";
        pill.textContent = k.keyword;
        missingPills.appendChild(pill);
      }
    }

    section.style.display = "block";
  } catch {
    analyzeBtn.textContent = "Analyze Keywords";
    analyzeBtn.disabled = false;
  }
}

// Analyze button click
document.getElementById("analyzeBtn")?.addEventListener("click", () => {
  runKeywordAnalysis();
});

// Toggle analysis body
document.getElementById("analysisToggle")?.addEventListener("click", () => {
  const body = document.getElementById("analysisBody");
  const expanded = body.style.display !== "none";
  body.style.display = expanded ? "none" : "block";
  document.getElementById("analysisToggle").setAttribute(
    "aria-expanded",
    String(!expanded)
  );
});

// Try sendMessage first; if the content script isn't loaded (e.g. LinkedIn
// SPA navigation, or the tab pre-dates the extension install), inject it
// and retry once.
function isMissingReceiverError(error) {
  const message = typeof error?.message === "string"
    ? error.message
    : String(error);
  return message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist");
}

async function sendMessageWithRetry(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function serverExtract(url) {
  if (!url || url.startsWith("chrome://")) return null;
  try {
    const res = await apiFetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function extractFromPage() {
  extractingEl.style.display = "block";
  formEl.style.display = "none";
  noPageEl.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      noPageEl.style.display = "block";
      extractingEl.style.display = "none";
      return;
    }

    const response = await sendMessageWithRetry(tab.id, { action: "extractJob" });

    let result = response;

    // If content script couldn't extract, fall back to server-side extraction
    if (!response.jobTitle && !response.company) {
      const serverResult = await serverExtract(tab.url);
      if (serverResult && (serverResult.jobTitle || serverResult.company)) {
        // Merge: keep content script's location/description if server didn't provide them
        result = {
          ...response,
          ...serverResult,
          location: response.location || serverResult.location || "",
          description: response.description || serverResult.description || "",
        };
      }
    }

    populateForm(result, tab.url);
  } catch {
    // Content script failed entirely — try server-side extraction
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab?.url || "";

    const serverResult = await serverExtract(pageUrl);
    if (serverResult && (serverResult.jobTitle || serverResult.company)) {
      populateForm(serverResult, pageUrl);
    } else {
      extractingEl.style.display = "none";
      formEl.style.display = "block";
      document.getElementById("jobUrl").value = pageUrl;
      showStatus("Could not extract from this page. Enter details manually.", "info");
    }
  }
}

saveBtn.addEventListener("click", async () => {
  const jobTitle = document.getElementById("jobTitle").value.trim();
  const company = document.getElementById("company").value.trim();
  const location = document.getElementById("location").value.trim();
  const description = document.getElementById("description").value.trim();
  const salary = document.getElementById("salary").value.trim();
  const jobType = document.getElementById("jobType").value.trim();
  const url = document.getElementById("jobUrl").value.trim();

  if (!jobTitle || !company) {
    showStatus("Job title and company are required.", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    const request = await authenticatedRequest("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url || "",
        jobTitle,
        company,
        location: location || null,
        description: description || null,
        salary: salary || null,
        jobType: jobType || null,
      }),
    });

    if (!request.response.ok) {
      throw new Error("Server returned " + request.response.status);
    }

    const result = await request.response.json();
    const appUrl = `${request.connection.serverUrl}/applications/${result.id}`;

    if (result.updated) {
      showStatus("Existing application updated with full details!", "success");
    } else {
      showStatus("Application saved to JobTracker!", "success");
    }
    saveBtn.textContent = "Saved!";

    // Replace "Open" link to go directly to this application
    const openLink = document.getElementById("openTracker");
    openLink.textContent = "View";
    openLink.dataset.appUrl = appUrl;
  } catch (err) {
    showStatus(
      err?.message || "Failed to save. Check the JobTracker connection.",
      "error"
    );
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Application";
  }
});

refreshBtn.addEventListener("click", () => {
  statusMsg.style.display = "none";
  extractFromPage();
});

document.getElementById("openTracker").addEventListener("click", (e) => {
  e.preventDefault();
  const openLink = document.getElementById("openTracker");
  let trackerUrl = serverUrlInput.value;
  try {
    trackerUrl = normalizeServerOrigin(trackerUrl);
  } catch {
    // This is normal navigation, not an authenticated extension API request.
  }
  const targetUrl = openLink.dataset.appUrl || trackerUrl;
  chrome.tabs.create({ url: targetUrl });
});

// Auto-fill profile URLs on application forms
async function fillProfiles() {
  const fillBtn = document.getElementById("fillProfilesBtn");

  try {
    const res = await apiFetch("/api/settings");
    if (!res.ok) return;
    const settings = await res.json();

    if (!settings.linkedinUrl && !settings.githubUrl) {
      if (fillBtn) fillBtn.style.display = "none";
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const response = await sendMessageWithRetry(tab.id, {
      action: "autoFillProfiles",
      profiles: {
        linkedinUrl: settings.linkedinUrl,
        githubUrl: settings.githubUrl,
      },
    });

    if (response?.filled?.length > 0) {
      showStatus(`Auto-filled: ${response.filled.join(", ")}`, "success");
    }
  } catch {
    // Silently fail — not on an application form
  }
}

document.getElementById("fillProfilesBtn")?.addEventListener("click", () => {
  fillProfiles();
});

connectBtn.addEventListener("click", () => {
  connectServer();
});

disconnectBtn.addEventListener("click", () => {
  disconnectServer();
});

async function initializePopup() {
  try {
    await requireTrustedStorage();
    const result = await chrome.storage.local.get([
      "connection",
      "serverUrl",
      "accessToken",
    ]);
    const stored = getStoredConnection(result || {});

    replaceCurrentConnection(null);
    const startupGeneration = connectionGeneration;
    clearApplicationTarget();
    accessTokenInput.value = "";
    if (typeof stored.serverUrl === "string" && stored.serverUrl) {
      serverUrlInput.value = stored.serverUrl;
    }
    if (stored.invalidated || !stored.accessToken || !stored.serverUrl) {
      setConnectionStatus(
        "Disconnected — enter an access token to connect.",
        "info"
      );
      return;
    }

    let origin;
    try {
      origin = normalizeServerOrigin(stored.serverUrl);
    } catch {
      setConnectionStatus("Stored server URL is invalid. Reconnect.", "error");
      return;
    }

    let response;
    try {
      response = await fetch(`${origin}/api/auth/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${stored.accessToken}` },
      });
    } catch {
      if (connectionGeneration === startupGeneration) {
        setConnectionStatus(
          "Stored connection could not be verified. Check the server and reconnect.",
          "error"
        );
      }
      return;
    }

    if (response.ok) {
      await mutateCredentials(async () => {
        if (connectionGeneration !== startupGeneration) return;
        if (stored.legacy) {
          await storeConnectionRecord({
            serverUrl: origin,
            accessToken: stored.accessToken,
            invalidated: false,
          });
        }
        replaceCurrentConnection({
          serverUrl: origin,
          accessToken: stored.accessToken,
        });
        serverUrlInput.value = origin;
        setConnectionStatus(`Connected to ${origin}`, "success");
      });
      return;
    }

    if (response.status === 401) {
      await mutateCredentials(async () => {
        if (connectionGeneration !== startupGeneration) return;
        replaceCurrentConnection(null);
        let storageClean = true;
        try {
          await storeConnectionRecord({
            serverUrl: origin,
            invalidated: true,
          });
        } catch {
          storageClean = false;
          try {
            await chrome.storage.local.remove(["connection", "accessToken"]);
          } catch {
            // Retry verification on the next popup open.
          }
        }
        const permissionClean = await removePermission(permissionPattern(origin));
        const warning = [
          !storageClean ? "Credential storage could not be updated." : "",
          !permissionClean ? "Host access could not be removed." : "",
        ].filter(Boolean).join(" ");
        setConnectionStatus(
          warning || "Connection expired. Enter the access token to reconnect.",
          "error"
        );
      });
      return;
    }

    if (connectionGeneration === startupGeneration) {
      setConnectionStatus("Stored connection was rejected. Reconnect.", "error");
    }
  } catch {
    // requireTrustedStorage already displayed a fail-closed compatibility error.
  } finally {
    extractFromPage();
  }
}

let initializationPromise = Promise.resolve();
if (typeof module === "undefined") {
  initializationPromise = initializePopup();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    apiFetch,
    connectServer,
    disconnectServer,
    extractFromPage,
    fillProfiles,
    initializationPromise,
    initializePopup,
    normalizeServerOrigin,
    permissionPattern,
    restoreConnection,
    runKeywordAnalysis,
    sendMessageWithRetry,
    serverExtract,
  };
}
