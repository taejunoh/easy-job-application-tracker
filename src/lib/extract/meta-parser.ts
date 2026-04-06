import * as cheerio from "cheerio";

export interface ParseResult {
  jobTitle: string | null;
  company: string | null;
}

export function parseMetaTags(html: string): ParseResult {
  const $ = cheerio.load(html);
  let jobTitle: string | null = null;
  let company: string | null = null;

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

  // Fallback to <title>
  if (!jobTitle) {
    const title = $("title").text().trim();
    if (title) jobTitle = title;
  }

  return { jobTitle, company };
}
