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

  const locationEl =
    document.querySelector(".job-details-jobs-unified-top-card__bullet") ||
    document.querySelector(".jobs-unified-top-card__bullet") ||
    document.querySelector(".top-card-layout__card .topcard__flavor--bullet");

  return {
    jobTitle: titleEl?.textContent?.trim() || "",
    company: companyEl?.textContent?.trim() || "",
    location: locationEl?.textContent?.trim() || "",
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
