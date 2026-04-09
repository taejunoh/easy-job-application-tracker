const SKILLS_DICTIONARY: Record<string, string[][]> = {
  "Programming Languages": [
    ["JavaScript", "JS"],
    ["TypeScript", "TS"],
    ["Python"],
    ["Java"],
    ["C++", "CPP", "C Plus Plus"],
    ["C#", "CSharp", "C Sharp"],
    ["Go", "Golang"],
    ["Rust"],
    ["Ruby"],
    ["PHP"],
    ["Swift"],
    ["Kotlin"],
    ["Scala"],
    ["SQL"],
    ["HTML", "HTML5"],
    ["CSS", "CSS3"],
    ["Bash", "Shell"],
    ["Perl"],
    ["Dart"],
    ["Lua"],
  ],
  "Frontend Frameworks": [
    ["React", "React.js", "ReactJS"],
    ["Next.js", "NextJS"],
    ["Vue", "Vue.js", "VueJS"],
    ["Angular", "AngularJS"],
    ["Svelte", "SvelteKit"],
    ["Remix"],
    ["Gatsby"],
    ["Tailwind", "Tailwind CSS", "TailwindCSS"],
    ["Bootstrap"],
    ["Material UI", "MUI"],
    ["Redux"],
    ["jQuery"],
    ["Sass", "SCSS"],
  ],
  "Backend Frameworks": [
    ["Node.js", "NodeJS"],
    ["Express", "Express.js", "ExpressJS"],
    ["Django"],
    ["Flask"],
    ["FastAPI"],
    ["Spring", "Spring Boot", "SpringBoot"],
    ["Rails", "Ruby on Rails"],
    ["Laravel"],
    ["ASP.NET"],
    ["NestJS", "Nest.js"],
    ["Hono"],
    ["Fastify"],
  ],
  Databases: [
    ["PostgreSQL", "Postgres"],
    ["MySQL"],
    ["MongoDB", "Mongo"],
    ["Redis"],
    ["SQLite"],
    ["DynamoDB"],
    ["Cassandra"],
    ["Elasticsearch", "ElasticSearch"],
    ["Prisma"],
    ["Supabase"],
    ["Firebase"],
    ["Neo4j"],
    ["MariaDB"],
  ],
  "Cloud & DevOps": [
    ["AWS", "Amazon Web Services"],
    ["GCP", "Google Cloud", "Google Cloud Platform"],
    ["Azure", "Microsoft Azure"],
    ["Docker"],
    ["Kubernetes", "K8s"],
    ["Terraform"],
    ["CI/CD", "CICD"],
    ["Jenkins"],
    ["GitHub Actions"],
    ["Vercel"],
    ["Netlify"],
    ["Heroku"],
    ["Ansible"],
    ["CloudFormation"],
    ["Pulumi"],
    ["Datadog"],
    ["Grafana"],
    ["Prometheus"],
    ["New Relic"],
  ],
  "Tools & Practices": [
    ["Git"],
    ["GitHub"],
    ["GitLab"],
    ["Bitbucket"],
    ["Jira"],
    ["Confluence"],
    ["Figma"],
    ["REST", "RESTful", "REST API"],
    ["GraphQL"],
    ["gRPC"],
    ["Agile"],
    ["Scrum"],
    ["Kanban"],
    ["TDD", "Test Driven Development"],
    ["Microservices"],
    ["Linux"],
    ["Webpack"],
    ["Vite"],
    ["npm"],
    ["Yarn"],
    ["pnpm"],
    ["Storybook"],
    ["Cypress"],
    ["Playwright"],
    ["Jest"],
    ["Selenium"],
    ["OAuth"],
    ["JWT"],
    ["WebSocket", "WebSockets"],
    ["RabbitMQ"],
    ["Kafka"],
    ["Nginx"],
  ],
  "Data & ML": [
    ["Machine Learning", "ML"],
    ["Deep Learning", "DL"],
    ["TensorFlow"],
    ["PyTorch"],
    ["Pandas"],
    ["NumPy"],
    ["Scikit-learn", "sklearn"],
    ["Data Science"],
    ["NLP", "Natural Language Processing"],
    ["Computer Vision"],
    ["LLM", "Large Language Model"],
    ["RAG", "Retrieval Augmented Generation"],
    ["Spark", "Apache Spark"],
    ["Hadoop"],
    ["Tableau"],
    ["Power BI"],
  ],
  "Mobile": [
    ["React Native"],
    ["Flutter"],
    ["iOS"],
    ["Android"],
    ["SwiftUI"],
    ["Jetpack Compose"],
    ["Expo"],
    ["Xamarin"],
  ],
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsTerm(
  normalizedText: string,
  originalTextLower: string,
  term: string
): boolean {
  const termLower = term.toLowerCase();

  // First try exact match on original text (handles "Node.js", "CI/CD", "C#", "C++")
  if (originalTextLower.includes(termLower)) {
    // For short terms (1-2 chars), verify it's a standalone word
    if (termLower.length <= 2) {
      const regex = new RegExp(`\\b${escapeRegex(termLower)}\\b`, "i");
      return regex.test(originalTextLower);
    }
    return true;
  }

  // Then try word-boundary match on normalized text
  const normalizedTerm = termLower.replace(/[.\-\/#+]/g, " ").replace(/\s+/g, " ").trim();
  if (normalizedTerm.length === 0) return false;

  const regex = new RegExp(`\\b${escapeRegex(normalizedTerm)}\\b`, "i");
  return regex.test(normalizedText);
}

export interface KeywordMatchResult {
  matchPercentage: number;
  matchedKeywords: { keyword: string; category: string }[];
  missingKeywords: { keyword: string; category: string }[];
  totalJobKeywords: number;
}

export function analyzeKeywordMatch(
  jobDescription: string,
  resumeText: string
): KeywordMatchResult {
  if (!jobDescription.trim() || !resumeText.trim()) {
    return {
      matchPercentage: 0,
      matchedKeywords: [],
      missingKeywords: [],
      totalJobKeywords: 0,
    };
  }

  const jdLower = jobDescription.toLowerCase();
  const jdNormalized = jdLower.replace(/[.\-\/#+]/g, " ").replace(/\s+/g, " ");

  const resumeLower = resumeText.toLowerCase();
  const resumeNormalized = resumeLower.replace(/[.\-\/#+]/g, " ").replace(/\s+/g, " ");

  const matched: { keyword: string; category: string }[] = [];
  const missing: { keyword: string; category: string }[] = [];

  for (const [category, aliasGroups] of Object.entries(SKILLS_DICTIONARY)) {
    for (const aliases of aliasGroups) {
      const canonicalName = aliases[0];

      // Check if any alias appears in the job description
      const inJD = aliases.some((alias) =>
        textContainsTerm(jdNormalized, jdLower, alias)
      );

      if (!inJD) continue;

      // Check if any alias appears in the resume
      const inResume = aliases.some((alias) =>
        textContainsTerm(resumeNormalized, resumeLower, alias)
      );

      if (inResume) {
        matched.push({ keyword: canonicalName, category });
      } else {
        missing.push({ keyword: canonicalName, category });
      }
    }
  }

  const total = matched.length + missing.length;

  return {
    matchPercentage: total > 0 ? Math.round((matched.length / total) * 100) : 0,
    matchedKeywords: matched,
    missingKeywords: missing,
    totalJobKeywords: total,
  };
}
