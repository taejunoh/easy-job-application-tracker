const formEl = document.getElementById("form");
const extractingEl = document.getElementById("extracting");
const noPageEl = document.getElementById("noPage");
const statusMsg = document.getElementById("statusMsg");
const saveBtn = document.getElementById("saveBtn");
const refreshBtn = document.getElementById("refreshBtn");
const serverUrlInput = document.getElementById("serverUrl");
const accessTokenInput = document.getElementById("accessToken");
const connectBtn = document.getElementById("connectBtn");
const connectionStatus = document.getElementById("connectionStatus");

let currentConnection = null;

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
  return `${origin}/*`;
}

function setConnectionStatus(message, type = "info", loading = false) {
  connectionStatus.textContent = message;
  connectionStatus.className = `connection-status ${type}`;
  connectBtn.disabled = loading;
  connectBtn.textContent = loading ? "Connecting..." : "Connect";
}

function restoreConnection(result) {
  currentConnection = null;
  accessTokenInput.value = "";

  if (typeof result?.serverUrl === "string" && result.serverUrl) {
    serverUrlInput.value = result.serverUrl;
  }

  if (typeof result?.accessToken === "string" && result.accessToken &&
      typeof result?.serverUrl === "string") {
    try {
      const origin = normalizeServerOrigin(result.serverUrl);
      currentConnection = { serverUrl: origin, accessToken: result.accessToken };
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

async function removePermissionQuietly(pattern) {
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    // Permission cleanup is best effort and never changes a verified pair.
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
  const oldConnection = currentConnection;
  let wasGranted = false;
  let granted = false;
  let stored = false;
  let phase = "permission";

  setConnectionStatus("Requesting access to the server...", "info", true);

  try {
    // Start both calls directly from the Connect click. request() therefore
    // retains the user gesture, while contains() tells us whether a failed
    // attempt introduced a permission that should be cleaned up.
    const containsPromise = Promise.resolve(
      chrome.permissions.contains({ origins: [pattern] })
    ).catch(() => false);
    const requestPromise = chrome.permissions.request({ origins: [pattern] });
    [wasGranted, granted] = await Promise.all([
      containsPromise,
      requestPromise,
    ]);

    if (!granted) {
      setConnectionStatus(
        "Server access was not granted. The previous connection is unchanged.",
        "error"
      );
      return;
    }

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
    await chrome.storage.local.set({ serverUrl: origin, accessToken: token });
    stored = true;
    currentConnection = { serverUrl: origin, accessToken: token };
    serverUrlInput.value = origin;
    setConnectionStatus(`Connected to ${origin}`, "success");

    if (oldConnection && oldConnection.serverUrl !== origin) {
      await removePermissionQuietly(permissionPattern(oldConnection.serverUrl));
    }
  } catch (error) {
    if (granted && !wasGranted && !stored) {
      await removePermissionQuietly(pattern);
    }

    if (phase === "permission") {
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
  } finally {
    accessTokenInput.value = "";
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
  }
}

async function apiFetch(path, init = {}) {
  if (!currentConnection) {
    throw new Error("Connect this extension to a server before using its API.");
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("API paths must be relative to the connected server.");
  }

  const connection = currentConnection;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${connection.accessToken}`);
  const response = await fetch(`${connection.serverUrl}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    currentConnection = null;
    accessTokenInput.value = "";
    try {
      await chrome.storage.local.remove("accessToken");
    } catch {
      // Keep the popup disconnected even if Chrome storage is unavailable.
    }
    setConnectionStatus(
      "Connection expired. Enter the access token to reconnect.",
      "error"
    );
    throw new Error("Connection expired. Reconnect to the server.");
  }

  return response;
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
  body.style.display = body.style.display === "none" ? "block" : "none";
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
    const res = await apiFetch("/api/applications", {
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

    if (!res.ok) {
      throw new Error("Server returned " + res.status);
    }

    const result = await res.json();
    const appUrl = `${currentConnection.serverUrl}/applications/${result.id}`;

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

// Restore the verified pair (or a legacy URL-only draft) before extraction.
chrome.storage.local.get(["serverUrl", "accessToken"], (result) => {
  restoreConnection(result);
  extractFromPage();
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    apiFetch,
    connectServer,
    extractFromPage,
    fillProfiles,
    normalizeServerOrigin,
    permissionPattern,
    restoreConnection,
    runKeywordAnalysis,
    sendMessageWithRetry,
    serverExtract,
  };
}
