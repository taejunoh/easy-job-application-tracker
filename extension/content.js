// Content script: extracts job data from supported job sites

function extractLinkedIn() {
  let jobTitle = "";
  let company = "";
  let location = "";
  let description = "";
  let _debug = "";

  // --- Job Title ---
  // Full detail page selectors
  const titleEl =
    document.querySelector(".job-details-jobs-unified-top-card__job-title h1") ||
    document.querySelector(".jobs-unified-top-card__job-title") ||
    document.querySelector(".top-card-layout__title") ||
    document.querySelector("h1.t-24");
  jobTitle = titleEl?.textContent?.trim() || "";

  // Search results: find via currentJobId link
  if (!jobTitle) {
    const jobId = new URL(window.location.href).searchParams.get("currentJobId");
    if (jobId) {
      const skip = /^(more|less|show|hide|save|apply|share|close|view|see)$/i;
      for (const link of document.querySelectorAll(`a[href*='${jobId}']`)) {
        const text = link.textContent?.trim() || "";
        if (text.length > 5 && !skip.test(text)) {
          jobTitle = text;
          break;
        }
      }
    }
  }

  if (!jobTitle) {
    jobTitle = document.querySelector("h1")?.textContent?.trim() || "";
  }

  // --- Company ---
  const companyEl =
    document.querySelector(".job-details-jobs-unified-top-card__company-name") ||
    document.querySelector(".jobs-unified-top-card__company-name") ||
    document.querySelector(".topcard__org-name-link");
  company = companyEl?.textContent?.trim() || "";

  if (!company) {
    for (const link of document.querySelectorAll("a[href*='/company/']")) {
      const text = link.textContent?.trim() || "";
      if (text.length > 1 && text.length < 60 && !/show|more|follow|employee/i.test(text)) {
        company = text;
        break;
      }
    }
  }

  // --- Location ---
  const noisePattern = /applicant|promoted|review|repost|hiring|click|apply|ago|week|day|hour|minute|benefit|medical|dental/i;

  // Detail page: primary description container
  const primaryDesc = document.querySelector(".job-details-jobs-unified-top-card__primary-description-container");
  if (primaryDesc) {
    for (const span of primaryDesc.querySelectorAll("span")) {
      const text = span.textContent?.trim() || "";
      if (!text || text.length > 80 || text.length < 3) continue;
      if (noisePattern.test(text)) continue;
      if (/^[A-Z][a-z]+.*,\s*[A-Z]{2}\b/.test(text) ||
          /Metropolitan Area/i.test(text) ||
          /^(remote|hybrid|on-?site)$/i.test(text)) {
        location = text;
        break;
      }
    }
  }

  // Detail page: bullet selectors
  if (!location) {
    const bulletEl =
      document.querySelector(".job-details-jobs-unified-top-card__bullet") ||
      document.querySelector(".jobs-unified-top-card__bullet");
    if (bulletEl) {
      const text = bulletEl.textContent?.trim() || "";
      if (!noisePattern.test(text)) location = text;
    }
  }

  // Search results: location is near the company name in the right panel
  // Scan all text near company for "City, ST" pattern
  if (!location && company) {
    // Find the company element we matched and look at siblings/nearby elements
    for (const link of document.querySelectorAll("a[href*='/company/']")) {
      if (link.textContent?.trim() !== company) continue;
      // Walk up to a broader container
      const parent = link.closest("div")?.parentElement?.parentElement;
      if (!parent) continue;
      // Scan text in the parent and its children
      for (const el of parent.querySelectorAll("span, div")) {
        const text = el.textContent?.trim() || "";
        if (!text || text.length > 60 || text.length < 3) continue;
        if (noisePattern.test(text)) continue;
        if (/^[A-Z][a-z]+.*,\s*[A-Z]{2}\b/.test(text) ||
            /Metropolitan Area/i.test(text) ||
            /^(Remote|Hybrid|On-?site)/i.test(text)) {
          location = text;
          break;
        }
      }
      if (location) break;
    }
  }

  // --- Salary & Job Type from badge pills ---
  let salary = "";
  let jobType = "";

  // Badges are links or spans with text like "$150K/yr - $210K/yr", "On-site", "Full-time", "Remote"
  const badgeEls = document.querySelectorAll("a[href*='currentJobId'], span, li, button");
  for (const el of badgeEls) {
    const text = el.textContent?.trim() || "";
    if (!text || text.length > 40) continue;
    // Salary: starts with $ or contains /yr, /hr
    if (!salary && /^\$[\d,]+[Kk]?\/[yh]r/.test(text)) {
      salary = text;
    }
    // Job type: On-site, Remote, Hybrid
    if (!jobType && /^(On-?site|Remote|Hybrid)$/i.test(text)) {
      // Normalize: "On-site" -> "Onsite"
      jobType = text.replace(/On-?site/i, "Onsite");
    }
  }

  // --- Description ---
  // "About the job" section on search results, or detail page selectors
  let descEl = null;

  // Search results: find the "About the job" heading and get the next sibling content
  const h2s = document.querySelectorAll("h2");
  for (const h2 of h2s) {
    if (h2.textContent?.trim() === "About the job") {
      // Description is in the next sibling element
      let sibling = h2.nextElementSibling;
      if (sibling) {
        descEl = sibling;
        break;
      }
      // Or try parent's next sibling
      sibling = h2.parentElement?.nextElementSibling;
      if (sibling) {
        descEl = sibling;
        break;
      }
    }
  }

  if (!descEl) {
    descEl =
      document.querySelector(".jobs-description__content") ||
      document.querySelector(".jobs-description-content__text") ||
      document.querySelector("[class*='jobs-description']") ||
      document.querySelector("#job-details") ||
      document.querySelector(".jobs-box__html-content") ||
      document.querySelector("[class*='description__text']");
  }
  description = descEl?.innerText?.trim() || "";

  return { jobTitle, company, location, description, salary, jobType };
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
