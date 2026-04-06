import { parseMetaTags } from "@/lib/extract/meta-parser";

describe("parseMetaTags", () => {
  it("extracts from Open Graph tags", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Software Engineer at Google" />
        <meta property="og:site_name" content="Google Careers" />
      </head><body></body></html>
    `;
    const result = parseMetaTags(html);
    expect(result.jobTitle).toBe("Software Engineer at Google");
    expect(result.company).toBe("Google Careers");
  });

  it("extracts from JSON-LD structured data", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {
            "@type": "JobPosting",
            "title": "Product Manager",
            "hiringOrganization": { "name": "Meta" }
          }
        </script>
      </head><body></body></html>
    `;
    const result = parseMetaTags(html);
    expect(result.jobTitle).toBe("Product Manager");
    expect(result.company).toBe("Meta");
  });

  it("falls back to <title> tag", () => {
    const html = `
      <html><head><title>Data Analyst - Stripe</title></head><body></body></html>
    `;
    const result = parseMetaTags(html);
    expect(result.jobTitle).toBe("Data Analyst - Stripe");
    expect(result.company).toBeNull();
  });

  it("returns nulls for empty HTML", () => {
    const result = parseMetaTags("<html><head></head><body></body></html>");
    expect(result.jobTitle).toBeNull();
    expect(result.company).toBeNull();
  });
});
