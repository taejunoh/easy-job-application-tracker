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

  // Search results: find the job title from the right detail panel
  if (!jobTitle) {
    const jobId = new URL(window.location.href).searchParams.get("currentJobId");
    // Strategy A: find a /jobs/view/{jobId} link with short text (title only, not card-wrapper)
    if (jobId) {
      for (const link of document.querySelectorAll(`a[href*='/jobs/view/${jobId}']`)) {
        const text = link.textContent?.trim() || "";
        if (text.length > 3 && text.length < 80) {
          jobTitle = text;
          break;
        }
      }
    }
    // Strategy B: any /jobs/view/ link with short text
    if (!jobTitle) {
      for (const link of document.querySelectorAll("a[href*='/jobs/view/']")) {
        const text = link.textContent?.trim() || "";
        if (text.length > 5 && text.length < 80) {
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

function extractLever() {
  const headlineEl = document.querySelector(".posting-headline h2");
  const jobTitle = headlineEl?.textContent?.trim() || "";

  const companyEl = document.querySelector(".main-header-logo img");
  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || "";
  const company = ogSiteName || companyEl?.alt || "";

  let location = "";
  const locationEl = document.querySelector(".posting-categories .sort-by-time.location .posting-category");
  if (locationEl) {
    location = locationEl.textContent?.trim() || "";
  }
  if (!location) {
    const locEl = document.querySelector(".location.posting-category");
    if (locEl) location = locEl.textContent?.trim() || "";
  }

  // Lever puts job description in multiple .section.page-centered divs
  // between posting-header and last-section-apply
  let description = "";
  const sections = document.querySelectorAll(".section.page-centered");
  const descParts = [];
  for (const section of sections) {
    if (section.classList.contains("posting-header")) continue;
    if (section.classList.contains("last-section-apply")) continue;
    const text = section.innerText?.trim();
    if (text) descParts.push(text);
  }
  description = descParts.join("\n\n");

  let salary = "";
  let jobType = "";
  const categories = document.querySelectorAll(".posting-category");
  for (const cat of categories) {
    const text = cat.textContent?.trim() || "";
    if (/On-?site|Remote|Hybrid/i.test(text)) {
      jobType = text.replace(/On-?site/i, "Onsite");
    }
    if (/\$[\d,]+/.test(text)) {
      salary = text;
    }
  }

  return { jobTitle, company, location, description, salary, jobType };
}

function extractGeneric() {
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || "";

  // Find job title from multiple strategies
  let jobTitle = "";

  // Strategy 1: Common ATS field-value selectors (Avature, etc.)
  const fieldSelectors = [
    ".article__content__view__field__value",
    "[class*='job-title']",
    "[class*='jobTitle']",
    "[class*='posting-headline']",
    "[data-automation-id='jobPostingHeader']",
  ];
  for (const sel of fieldSelectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim() || "";
    if (text.length > 5 && text.length < 120) {
      jobTitle = text;
      break;
    }
  }

  // Strategy 2: Visible h1 that isn't just the company name
  if (!jobTitle) {
    const h1 = document.querySelector("h1");
    if (h1) {
      const text = h1.textContent?.trim() || "";
      const isHidden = h1.className?.includes("hidden") || h1.offsetHeight === 0;
      if (text.length > 3 && !isHidden &&
          text.toLowerCase() !== ogSiteName.toLowerCase() &&
          text.toLowerCase() !== company.toLowerCase()) {
        jobTitle = text;
      }
    }
  }

  // Strategy 3: h2 that looks like a job title (not a section header)
  if (!jobTitle) {
    const sectionHeaders = /description|requirement|accommodation|equal opportunity|privacy|about|benefit|overview|apply|similar/i;
    for (const h2 of document.querySelectorAll("h2")) {
      const text = h2.textContent?.trim() || "";
      if (text.length > 5 && text.length < 120 && !sectionHeaders.test(text)) {
        jobTitle = text;
        break;
      }
    }
  }

  // Strategy 4: og:title fallback
  if (!jobTitle) {
    jobTitle = ogTitle;
  }

  // Company: og:site_name, or try the page domain
  let company = ogSiteName;
  if (!company) {
    const domain = window.location.hostname.replace(/^www\./, "").split(".")[0];
    company = domain.charAt(0).toUpperCase() + domain.slice(1);
  }

  // Location: check dedicated elements, then scan for "Location:" labels
  let location = "";
  const locationEl = document.querySelector("[class*='location'], [data-testid*='location'], [itemprop='jobLocation']");
  if (locationEl) location = locationEl.textContent?.trim() || "";

  if (!location) {
    // Find elements with text "Location" and grab the next sibling or value
    for (const el of document.querySelectorAll("*")) {
      const text = el.textContent?.trim() || "";
      if (text === "Location:" || text === "Location") {
        // Check next sibling
        const next = el.nextElementSibling;
        if (next) {
          const val = next.textContent?.trim() || "";
          if (val.length > 1 && val.length < 60) { location = val; break; }
        }
        // Check parent's next sibling
        const parentNext = el.parentElement?.nextElementSibling;
        if (!location && parentNext) {
          const val = parentNext.textContent?.trim() || "";
          if (val.length > 1 && val.length < 60) { location = val; break; }
        }
      }
    }
  }

  // Description
  const descEl = document.querySelector("[class*='description']") ||
    document.querySelector("[class*='job-detail']") ||
    document.querySelector("[class*='posting-page']") ||
    document.querySelector("[class*='job-content']") ||
    document.querySelector("[class*='jobContent']") ||
    document.querySelector("article") ||
    document.querySelector("[role='main']") ||
    document.querySelector(".content");

  return {
    jobTitle,
    company,
    location,
    description: descEl?.innerText?.trim() || "",
  };
}

function extractJobData() {
  const hostname = window.location.hostname;

  if (hostname.includes("linkedin.com")) return extractLinkedIn();
  if (hostname.includes("indeed.com")) return extractIndeed();
  if (hostname.includes("glassdoor.com")) return extractGlassdoor();
  if (hostname.includes("lever.co")) return extractLever();
  return extractGeneric();
}

// Auto-fill profile URLs on job application forms
function autoFillProfiles(profiles) {
  const { linkedinUrl, githubUrl } = profiles;
  let filled = [];

  // Find all input fields and textareas on the page
  const inputs = document.querySelectorAll("input[type='text'], input[type='url'], input:not([type]), textarea");

  for (const input of inputs) {
    const label = findLabelFor(input);
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();
    const placeholder = (input.placeholder || "").toLowerCase();
    const hint = `${label} ${name} ${id} ${placeholder}`;

    // LinkedIn field
    if (linkedinUrl && !input.value && /linkedin/i.test(hint)) {
      setInputValue(input, linkedinUrl);
      filled.push("LinkedIn");
    }

    // GitHub field
    if (githubUrl && !input.value && /github/i.test(hint)) {
      setInputValue(input, githubUrl);
      filled.push("GitHub");
    }
  }

  return filled;
}

// Find the label text associated with an input
function findLabelFor(input) {
  // Check for <label for="id">
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent || "";
  }
  // Check for parent <label>
  const parentLabel = input.closest("label");
  if (parentLabel) return parentLabel.textContent || "";
  // Check for preceding label sibling
  const prev = input.previousElementSibling;
  if (prev && prev.tagName === "LABEL") return prev.textContent || "";
  // Check parent's preceding sibling or parent's label-like child
  const parent = input.parentElement;
  if (parent) {
    const prevSibling = parent.previousElementSibling;
    if (prevSibling) return prevSibling.textContent || "";
    // Look for a label-like element in the parent's parent
    const grandparent = parent.parentElement;
    if (grandparent) {
      const labelEl = grandparent.querySelector("label, [class*='label'], [class*='Label']");
      if (labelEl && labelEl !== input) return labelEl.textContent || "";
    }
  }
  return "";
}

// Set input value and trigger React/framework change events
function setInputValue(input, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set || Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractJob") {
    const data = extractJobData();
    data.url = window.location.href;
    sendResponse(data);
  }
  if (request.action === "autoFillProfiles") {
    const filled = autoFillProfiles(request.profiles);
    sendResponse({ filled });
  }
  return true;
});
