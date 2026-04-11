// Synthetic data used by scripts/screenshots.mjs to render the app
// without touching the real Postgres database. All names and values
// are fictional placeholders.

export const statsFixture = {
  total: 6,
  applied: 3,
  interview: 1,
  offer: 1,
  rejected: 1,
  weeklyCount: 4,
  monthlyCount: 6,
  recentApplications: [
    { id: "1", jobTitle: "Senior Frontend Engineer", company: "Acme Corp",     status: "Interview", appliedDate: "2026-04-08T00:00:00.000Z" },
    { id: "2", jobTitle: "Full Stack Developer",     company: "Globex Inc",    status: "Applied",   appliedDate: "2026-04-07T00:00:00.000Z" },
    { id: "3", jobTitle: "Staff Engineer",           company: "Initech",       status: "Applied",   appliedDate: "2026-04-05T00:00:00.000Z" },
    { id: "4", jobTitle: "Platform Engineer",        company: "Hooli",         status: "Offer",     appliedDate: "2026-04-02T00:00:00.000Z" },
    { id: "5", jobTitle: "Backend Engineer",         company: "Umbrella Corp", status: "Applied",   appliedDate: "2026-03-30T00:00:00.000Z" },
    { id: "6", jobTitle: "ML Engineer",              company: "Pied Piper",    status: "Rejected",  appliedDate: "2026-03-28T00:00:00.000Z" },
  ],
};

export const settingsFixture = {
  llmProvider: "anthropic",
  hasApiKey: true,
  linkedinUrl: "https://linkedin.com/in/jane-doe",
  githubUrl: "https://github.com/jane-doe",
  resumeText:
    "Jane Doe\nSoftware Engineer\n\n" +
    "Experience\n" +
    "- Senior Frontend Engineer at Example Co (2023-present)\n" +
    "  Built React/TypeScript apps, optimized bundle size,\n" +
    "  led design system migration.\n" +
    "- Software Engineer at Demo Inc (2020-2023)\n" +
    "  Node.js APIs, PostgreSQL schema design, REST endpoints.\n\n" +
    "Skills\n" +
    "React, TypeScript, Node.js, PostgreSQL, REST, Git, CI/CD",
};

export const popupFormFixture = {
  jobTitle: "Senior Frontend Engineer",
  company: "Acme Corp",
  location: "San Francisco, CA (Remote)",
};

export const keywordAnalysisFixture = {
  percentage: 67,
  badgeClass: "badge-yellow",
  fillClass: "fill-yellow",
  matched: ["React", "TypeScript", "Node.js", "REST", "Git", "PostgreSQL"],
  missing: ["Kubernetes", "GraphQL", "Rust"],
};
