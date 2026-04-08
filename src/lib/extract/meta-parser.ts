import * as cheerio from "cheerio";

export interface ParseResult {
  jobTitle: string | null;
  company: string | null;
  location: string | null;
}

export function parseMetaTags(html: string): ParseResult {
  const $ = cheerio.load(html);
  let jobTitle: string | null = null;
  let company: string | null = null;
  let location: string | null = null;

  // Try JSON-LD first (most structured)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || "");
      const posting = data["@type"] === "JobPosting" ? data : null;
      if (posting) {
        if (posting.title) jobTitle = posting.title;
        if (posting.hiringOrganization?.name) {
          company = posting.hiringOrganization.name;
        }
        if (posting.jobLocation) {
          const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
          const locParts = locations.map((loc: { address?: { addressLocality?: string; addressRegion?: string } }) => {
            const addr = loc.address;
            if (!addr) return null;
            return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");
          }).filter(Boolean);
          if (locParts.length) location = locParts.join("; ");
        }
      }
    } catch {
      // Invalid JSON, skip
    }
  });

  // Try Open Graph tags
  if (!jobTitle) {
    jobTitle = $('meta[property="og:title"]').attr("content") || null;
  }
  if (!company) {
    company = $('meta[property="og:site_name"]').attr("content") || null;
  }

  // Fallback to <title>, stripping "in Location | Company" suffixes
  if (!jobTitle) {
    let title = $("title").text().trim();
    // Remove " | Company" or " - Company" suffix
    title = title.replace(/\s*[|–—-]\s*[^|–—-]+$/, "").trim();
    // Remove " in Location" suffix
    title = title.replace(/\s+in\s+.+$/i, "").trim();
    if (title) jobTitle = title;
  }

  // Location fallback: look for "Location:" label in HTML
  if (!location) {
    $("strong, b, dt, label, span").each((_, el) => {
      const text = $(el).text().trim();
      if (/^(Location|Locations|Multiple Locations):?$/i.test(text)) {
        // The value might be a text node right after the label element
        const parent = $(el).parent();
        const parentText = parent.text().trim();
        const match = parentText.match(/(?:Location|Locations|Multiple Locations):?\s*(.+)/i);
        if (match && match[1].length < 100) {
          location = match[1].trim();
          return false;
        }
        // Or in the next sibling element
        const next = $(el).next();
        const val = next.length ? next.text().trim() : "";
        if (val && val.length < 100) {
          location = val;
          return false;
        }
      }
    });
  }

  // Location fallback: parse from title tag "Job Title in Location | Company"
  if (!location) {
    const title = $("title").text().trim();
    const inMatch = title.match(/\bin\s+(.+?)(?:\s*\||\s*[-–—]|\s*$)/i);
    if (inMatch && inMatch[1].length < 80) {
      location = inMatch[1].trim();
    }
  }

  return { jobTitle, company, location };
}
