const SKILLS_DICTIONARY: Record<string, string[][]> = {
  "Programming Languages": [
    ["JavaScript", "JS"],
    ["TypeScript", "TS"],
    ["Python"],
    ["Java"],
    ["C++", "CPP", "C Plus Plus"],
    ["C#", "CSharp", "C Sharp"],
    ["Go", "Golang", "Go language"],
    ["Rust"],
    ["Ruby"],
    ["PHP"],
    ["Swift", "Swift programming", "Swift language", "Swift/SwiftUI"],
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
    ["Express", "Express.js", "ExpressJS", "Express framework"],
    ["Django"],
    ["Flask"],
    ["FastAPI"],
    ["Spring", "Spring Boot", "SpringBoot", "Spring Framework", "Spring MVC"],
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
    ["REST", "RESTful", "REST API", "REST APIs", "RESTful API", "RESTful APIs"],
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
    ["Spark", "Apache Spark", "PySpark", "Spark SQL"],
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

const HAS_SPECIAL_CHARS = /[.\-\/#+]/;

// Terms that are common English words — skip standalone matching, rely on their aliases
const AMBIGUOUS_TERMS = new Set([
  "go",        // "go to market" — use Golang, Go language
  "r",         // too short — would need R language alias
  "rest",      // "the rest of the team" — use RESTful, REST API
  "express",   // "express interest" — use Express.js, ExpressJS
  "swift",     // "swift response" — use Swift programming, SwiftUI
  "spring",    // "this spring" — use Spring Boot, Spring Framework
  "spark",     // "spark innovation" — use Apache Spark
]);

function textContainsTerm(
  normalizedText: string,
  originalTextLower: string,
  term: string
): boolean {
  const termLower = term.toLowerCase();

  // Terms with special chars (e.g. "Node.js", "C++", "C#", "CI/CD"):
  // check exact substring match on original text, then verify word boundary
  if (HAS_SPECIAL_CHARS.test(termLower)) {
    if (originalTextLower.includes(termLower)) {
      return true;
    }
    // Also try normalized form with word boundaries
    const normalizedTerm = termLower.replace(/[.\-\/#+]/g, " ").replace(/\s+/g, " ").trim();
    if (normalizedTerm.length === 0) return false;
    const regex = new RegExp(`\\b${escapeRegex(normalizedTerm)}\\b`, "i");
    return regex.test(normalizedText);
  }

  // Plain terms: always use word-boundary regex to avoid substring false positives
  // (e.g. "Java" must not match "JavaScript", "Git" must not match "digital")

  // Skip ambiguous short terms that are common English words
  // (e.g. "Go" matches "go to market" — rely on aliases like "Golang" instead)
  if (AMBIGUOUS_TERMS.has(termLower)) {
    return false;
  }

  const regex = new RegExp(`\\b${escapeRegex(termLower)}\\b`, "i");
  return regex.test(originalTextLower);
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
