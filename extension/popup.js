const formEl = document.getElementById("form");
const extractingEl = document.getElementById("extracting");
const noPageEl = document.getElementById("noPage");
const statusMsg = document.getElementById("statusMsg");
const saveBtn = document.getElementById("saveBtn");
const refreshBtn = document.getElementById("refreshBtn");

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
}

async function serverExtract(url) {
  if (!url || url.startsWith("chrome://")) return null;
  const serverUrl = document.getElementById("serverUrl").value.replace(/\/$/, "");
  try {
    const res = await fetch(`${serverUrl}/api/extract`, {
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

    // Inject content script if not on a matched page
    const isJobSite = /linkedin\.com\/jobs|indeed\.com|glassdoor\.com\/job|glassdoor\.com\/Job/.test(tab.url);

    if (!isJobSite) {
      // Try injecting content script for generic pages
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    }

    // Give content script time to load
    await new Promise((r) => setTimeout(r, 300));

    const response = await chrome.tabs.sendMessage(tab.id, { action: "extractJob" });

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
  } catch (err) {
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
  const serverUrl = document.getElementById("serverUrl").value.replace(/\/$/, "");
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
    const res = await fetch(`${serverUrl}/api/applications`, {
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
    const appUrl = `${serverUrl}/applications/${result.id}`;

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
      `Failed to save. Is JobTracker running at ${serverUrl}?`,
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
  const targetUrl = openLink.dataset.appUrl || document.getElementById("serverUrl").value.replace(/\/$/, "");
  chrome.tabs.create({ url: targetUrl });
});

// Auto-fill profile URLs on application forms
async function fillProfiles() {
  const serverUrl = document.getElementById("serverUrl").value.replace(/\/$/, "");
  const fillBtn = document.getElementById("fillProfilesBtn");

  try {
    const res = await fetch(`${serverUrl}/api/settings`);
    if (!res.ok) return;
    const settings = await res.json();

    if (!settings.linkedinUrl && !settings.githubUrl) {
      if (fillBtn) fillBtn.style.display = "none";
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // Inject content script if needed
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch {
      // Already injected
    }

    await new Promise((r) => setTimeout(r, 200));

    const response = await chrome.tabs.sendMessage(tab.id, {
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

// Auto-extract on popup open
extractFromPage();
