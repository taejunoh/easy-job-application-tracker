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

    document.getElementById("jobTitle").value = response.jobTitle || "";
    document.getElementById("company").value = response.company || "";
    document.getElementById("location").value = response.location || "";
    document.getElementById("description").value = response.description || "";
    document.getElementById("salary").value = response.salary || "";
    document.getElementById("jobType").value = response.jobType || "";
    document.getElementById("jobUrl").value = response.url || tab.url;

    extractingEl.style.display = "none";
    formEl.style.display = "block";

    if (!response.jobTitle && !response.company) {
      showStatus("Could not auto-detect job data. Please fill in manually.", "info");
    }
  } catch (err) {
    extractingEl.style.display = "none";
    formEl.style.display = "block";
    document.getElementById("jobUrl").value = "";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      document.getElementById("jobUrl").value = tab.url;
    }

    showStatus("Could not extract from this page. Enter details manually.", "info");
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

// Auto-extract on popup open
extractFromPage();
