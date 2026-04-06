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

  // Strategy 1: Look for the primary/secondary description span that contains location text
  const primaryDesc = document.querySelector(".job-details-jobs-unified-top-card__primary-description-container");
  if (primaryDesc) {
    // Location is typically the first text segment (before the interpunct or dot separator)
    const text = primaryDesc.textContent || "";
    const parts = text.split(/\s*·\s*|\s*•\s*/);
    if (parts.length > 0) {
      // Find the part that looks like a location (contains comma, state abbreviation, or "Remote")
      for (const part of parts) {
        const trimmed = part.trim();
        if (/,|\b[A-Z]{2}\b|remote|hybrid|on-?site/i.test(trimmed) && trimmed.length < 100) {
          location = trimmed;
          break;
        }
      }
    }
  }

  // Strategy 2: Common class-based selectors
  if (!location) {
    const locationEl =
      document.querySelector(".job-details-jobs-unified-top-card__bullet") ||
      document.querySelector(".jobs-unified-top-card__bullet") ||
      document.querySelector(".job-details-jobs-unified-top-card__workplace-type") ||
      document.querySelector(".top-card-layout__card .topcard__flavor--bullet") ||
      document.querySelector("[class*='top-card'] [class*='bullet']") ||
      document.querySelector("[class*='top-card'] [class*='location']") ||
      document.querySelector("[class*='top-card'] [class*='workplace']");
    if (locationEl) {
      location = locationEl.textContent?.trim() || "";
    }
  }

  // Strategy 3: Search all spans in the top card area for location-like text
  if (!location) {
    const topCard = document.querySelector("[class*='jobs-unified-top-card']") ||
      document.querySelector("[class*='job-details-jobs-unified-top-card']");
    if (topCard) {
      const spans = topCard.querySelectorAll("span");
      for (const span of spans) {
        const text = span.textContent?.trim() || "";
        // Match patterns like "City, ST", "Remote", "City, State (On-site)"
        if (/^[A-Z][a-z]+.*,\s*[A-Z]/.test(text) || /^(remote|hybrid)/i.test(text)) {
          if (text.length < 80) {
            location = text;
            break;
          }
        }
      }
    }
  }

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location,
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

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location: locationEl?.textContent?.trim() || "",
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

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location: locationEl?.textContent?.trim() || "",
  };
}

function extractGeneric() {
  // Try common patterns
  const h1 = document.querySelector("h1");
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogSiteName = document.querySelector('meta[property="og:site_name"]');

  return {
    jobTitle: h1?.textContent?.trim() || ogTitle?.getAttribute("content") || "",
    company: ogSiteName?.getAttribute("content") || "",
    location: "",
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
