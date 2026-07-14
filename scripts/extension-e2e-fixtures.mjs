export const E2E_SERVER_HOST = "127.0.0.1";
export const E2E_SERVER_PORT = 3100;
export const E2E_SERVER_ORIGIN =
  `http://${E2E_SERVER_HOST}:${E2E_SERVER_PORT}`;
export const E2E_ACCESS_TOKEN =
  "extension-e2e-access-token-aaaaaaaaaaaaaaaa";
export const E2E_INVALID_ACCESS_TOKEN =
  "extension-e2e-invalid-token-bbbbbbbbbbbbbbbb";
export const E2E_ENCRYPTION_SECRET =
  "extension-e2e-encryption-secret-cccccccccccc";
export const LEVER_FIXTURE_URL =
  "https://jobs.lever.co/jobtracker-e2e/senior-platform-engineer";

export const LEVER_EXPECTED_APPLICATION = Object.freeze({
  url: LEVER_FIXTURE_URL,
  jobTitle: "Senior Platform Engineer",
  company: "JobTracker E2E",
  location: "New York, NY",
  jobType: "Remote",
  salary: "$170,000 - $210,000",
  description:
    "Build reliable distributed systems for the JobTracker E2E platform.\n\nPartner with product engineers to ship observable, secure services.",
});

export const LEVER_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta property="og:site_name" content="JobTracker E2E">
    <title>Senior Platform Engineer - JobTracker E2E</title>
  </head>
  <body>
    <header class="main-header-logo">
      <img alt="JobTracker E2E" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    </header>
    <section class="section page-centered posting-header">
      <div class="posting-headline">
        <h2>Senior Platform Engineer</h2>
        <div class="posting-categories">
          <div class="sort-by-time location">
            <span class="posting-category">New York, NY</span>
          </div>
          <span class="posting-category">Remote</span>
          <span class="posting-category">$170,000 - $210,000</span>
        </div>
      </div>
    </section>
    <section class="section page-centered">
      <p>Build reliable distributed systems for the JobTracker E2E platform.</p>
    </section>
    <section class="section page-centered">
      <p>Partner with product engineers to ship observable, secure services.</p>
    </section>
    <section class="section page-centered last-section-apply">
      <button type="button">Apply</button>
    </section>
  </body>
</html>`;
