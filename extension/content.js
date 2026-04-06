// Content script: extracts job data from supported job sites

function extractLinkedIn() {
  const titleEl =
    document.querySelector(".job-details-jobs-unified-top-card__job-title h1") ||
    document.querySelector(".jobs-unified-top-card__job-title") ||
    document.querySelector(".top-card-layout__title") ||
    document.querySelector("h1.t-24") ||
    document.querySelector("h1");

  const companyEl =
    document.querySelector(".job-details-jobs-unified-top-card__company-name") ||
    document.querySelector(".jobs-unified-top-card__company-name") ||
    document.querySelector(".top-card-layout__card a[data-tracking-control-name]") ||
    document.querySelector(".topcard__org-name-link") ||
    document.querySelector("a.app-aware-link[href*='/company/']");

  // Location: LinkedIn puts it in various places — try multiple strategies
  let location = "";

  // Noise patterns to reject
  const noisePattern = /applicant|promoted|review|repost|hiring|click|apply|ago|week|day|hour|minute/i;

  // Strategy 1: Look for spans inside the primary description that contain location-like text
  const primaryDesc = document.querySelector(".job-details-jobs-unified-top-card__primary-description-container");
  if (primaryDesc) {
    const spans = primaryDesc.querySelectorAll("span");
    for (const span of spans) {
      const text = span.textContent?.trim() || "";
      if (!text || text.length > 80 || text.length < 3) continue;
      if (noisePattern.test(text)) continue;
      // Match "City, State", "City Metropolitan Area", "Remote", "United States"
      if (/metropolitan|area/i.test(text) ||
          /^[A-Z][a-z]+,\s*[A-Z]/.test(text) ||
          /^(remote|hybrid|on-?site)$/i.test(text) ||
          /^[A-Z][a-z]+\s+(state|county|city)/i.test(text) ||
          /united states|canada|united kingdom/i.test(text)) {
        location = text;
        break;
      }
    }
  }

  // Strategy 2: Common class-based selectors
  if (!location) {
    const locationEl =
      document.querySelector(".job-details-jobs-unified-top-card__bullet") ||
      document.querySelector(".jobs-unified-top-card__bullet") ||
      document.querySelector(".top-card-layout__card .topcard__flavor--bullet");
    if (locationEl) {
      const text = locationEl.textContent?.trim() || "";
      if (!noisePattern.test(text)) location = text;
    }
  }

  // Strategy 3: Search all spans in the top card for location patterns
  if (!location) {
    const topCard = document.querySelector("[class*='jobs-unified-top-card']") ||
      document.querySelector("[class*='job-details-jobs-unified-top-card']");
    if (topCard) {
      const spans = topCard.querySelectorAll("span");
      for (const span of spans) {
        const text = span.textContent?.trim() || "";
        if (!text || text.length > 60 || text.length < 3) continue;
        if (noisePattern.test(text)) continue;
        if (/^[A-Z][a-z]+.*,\s*[A-Z]/.test(text) ||
            /metropolitan|area/i.test(text) ||
            /^(remote|hybrid)/i.test(text)) {
          location = text;
          break;
        }
      }
    }
  }

  // Job description
  const descEl =
    document.querySelector(".jobs-description__content") ||
    document.querySelector(".jobs-description-content__text") ||
    document.querySelector("[class*='jobs-description']") ||
    document.querySelector("#job-details") ||
    document.querySelector("[class*='description__text']");

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location,
    description: descEl?.innerText?.trim() || "",
  };
}

function extractIndeed() {
  const titleEl =
    document.querySelector(".jobsearch-JobInfoHeader-title") ||
    document.querySelector("h1.icl-u-xs-mb--xs") ||
    document.querySelector("h1");

  const companyEl =
    document.querySelector("[data-company-name]") ||
    document.querySelector(".jobsearch-InlineCompanyRating a") ||
    document.querySelector(".icl-u-lg-mr--sm a");

  const locationEl =
    document.querySelector("[data-testid='job-location']") ||
    document.querySelector(".jobsearch-JobInfoHeader-subtitle .icl-u-xs-mt--xs");

  const descEl =
    document.querySelector("#jobDescriptionText") ||
    document.querySelector(".jobsearch-JobComponent-description") ||
    document.querySelector("[id*='jobDescription']");

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location: locationEl?.textContent?.trim() || "",
    description: descEl?.innerText?.trim() || "",
  };
}

function extractGlassdoor() {
  const titleEl =
    document.querySelector("[data-test='jobTitle']") ||
    document.querySelector(".css-1vg6q84") ||
    document.querySelector("h1");

  const companyEl =
    document.querySelector("[data-test='employerName']") ||
    document.querySelector(".css-87uc0g") ||
    document.querySelector(".employerName");

  const locationEl =
    document.querySelector("[data-test='location']") ||
    document.querySelector(".css-56kyx5");

  const descEl =
    document.querySelector("[data-test='jobDescriptionContent']") ||
    document.querySelector(".jobDescriptionContent") ||
    document.querySelector("[class*='jobDescription']");

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location: locationEl?.textContent?.trim() || "",
    description: descEl?.innerText?.trim() || "",
  };
}

function extractGeneric() {
  // Try common patterns
  const h1 = document.querySelector("h1");
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogSiteName = document.querySelector('meta[property="og:site_name"]');

  const descEl = document.querySelector("[class*='description']") ||
    document.querySelector("article") ||
    document.querySelector("[role='main']");

  return {
    jobTitle: h1?.textContent?.trim() || ogTitle?.getAttribute("content") || "",
    company: ogSiteName?.getAttribute("content") || "",
    location: "",
    description: descEl?.innerText?.trim() || "",
  };
}

function extractJobData() {
  const hostname = window.location.hostname;

  if (hostname.includes("linkedin.com")) return extractLinkedIn();
  if (hostname.includes("indeed.com")) return extractIndeed();
  if (hostname.includes("glassdoor.com")) return extractGlassdoor();
  return extractGeneric();
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractJob") {
    const data = extractJobData();
    data.url = window.location.href;
    sendResponse(data);
  }
  return true;
});
