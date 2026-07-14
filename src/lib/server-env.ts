import "server-only";

type ServerEnvSource = Record<string, string | undefined>;

type ServerNodeEnv = "development" | "production" | "test" | string | undefined;

export type ServerEnv = Readonly<{
  databaseUrl: string;
  encryptionSecret: string;
  appAccessToken: string;
  appBaseUrl: string;
  appOrigin: string;
  corsAllowedOrigins: readonly string[];
}>;

const SECRET_PLACEHOLDERS = new Set([
  "any-random-string-at-least-32-characters-long",
  "example-encryption-secret-value-1234",
  "generate-a-random-32-char-string-here",
  "generate-a-random-32-character-secret-here",
  "generate-a-random-32-character-token-here",
  "generate_with_openssl_rand_base64_32",
  "replace-with-your-application-token-now",
  "replace-with-your-encryption-secret-now",
  "sample-app-access-token-value-12345",
]);

const DATABASE_URL_PLACEHOLDERS = new Set([
  "postgresql://user:password@host:5432/dbname?sslmode=require",
]);

const TEMPLATE_MARKER_PATTERN = /<[^<>]+>/;

let cachedServerEnv: ServerEnv | undefined;

export function parseServerEnv(
  source: ServerEnvSource,
  nodeEnv: ServerNodeEnv,
): ServerEnv {
  const databaseUrl = parseDatabaseUrl(required(source, "DATABASE_URL"));
  const encryptionSecret = parseSecret(
    "ENCRYPTION_SECRET",
    required(source, "ENCRYPTION_SECRET"),
  );
  const appAccessToken = parseSecret(
    "APP_ACCESS_TOKEN",
    required(source, "APP_ACCESS_TOKEN"),
  );
  const appBaseUrl = required(source, "APP_BASE_URL");
  const appOrigin = parseAppOrigin(appBaseUrl, nodeEnv);
  const corsAllowedOrigins = parseCorsOrigins(
    required(source, "CORS_ALLOWED_ORIGINS"),
    appOrigin,
    nodeEnv,
  );

  return Object.freeze({
    databaseUrl,
    encryptionSecret,
    appAccessToken,
    appBaseUrl,
    appOrigin,
    corsAllowedOrigins,
  });
}

export function getServerEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv(process.env, process.env.NODE_ENV);
  return cachedServerEnv;
}

function required(source: ServerEnvSource, name: string): string {
  const value = source[name];
  if (value === undefined || value.length === 0) {
    invalid(name, "is required");
  }
  return value;
}

function parseDatabaseUrl(value: string): string {
  const name = "DATABASE_URL";
  if (
    value !== value.trim() ||
    TEMPLATE_MARKER_PATTERN.test(value) ||
    DATABASE_URL_PLACEHOLDERS.has(value.toLowerCase()) ||
    value.includes("#")
  ) {
    invalid(name, "must be a valid PostgreSQL connection URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(name, "must be a valid PostgreSQL connection URL");
  }

  const databaseName = url.pathname.slice(1);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !databaseName ||
    databaseName.includes("/")
  ) {
    invalid(name, "must be a valid PostgreSQL connection URL");
  }

  return value;
}

function parseSecret(name: string, value: string): string {
  if (
    Buffer.byteLength(value, "utf8") < 32 ||
    /\s/u.test(value) ||
    SECRET_PLACEHOLDERS.has(value.toLowerCase()) ||
    TEMPLATE_MARKER_PATTERN.test(value)
  ) {
    invalid(name, "must be a non-placeholder secret of at least 32 bytes");
  }
  return value;
}

function parseAppOrigin(value: string, nodeEnv: ServerNodeEnv): string {
  const name = "APP_BASE_URL";
  if (
    value !== value.trim() ||
    TEMPLATE_MARKER_PATTERN.test(value) ||
    /[*?#]/u.test(value)
  ) {
    invalid(name, "must be an allowed absolute application origin");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(name, "must be an allowed absolute application origin");
  }

  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !isAllowedWebProtocol(url, nodeEnv)
  ) {
    invalid(name, "must be an allowed absolute application origin");
  }

  return url.origin;
}

function parseCorsOrigins(
  value: string,
  appOrigin: string,
  nodeEnv: ServerNodeEnv,
): readonly string[] {
  const name = "CORS_ALLOWED_ORIGINS";
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    invalid(name, "must be a non-empty list of unique origins");
  }

  const origins = entries.map((entry) => parseCorsOrigin(entry, nodeEnv));
  const uniqueOrigins = new Set(origins);
  if (uniqueOrigins.size !== origins.length || !uniqueOrigins.has(appOrigin)) {
    invalid(name, "must contain the application origin exactly once");
  }

  return Object.freeze(origins);
}

function parseCorsOrigin(value: string, nodeEnv: ServerNodeEnv): string {
  const name = "CORS_ALLOWED_ORIGINS";
  if (
    value === "null" ||
    TEMPLATE_MARKER_PATTERN.test(value) ||
    /[*?#]/u.test(value)
  ) {
    invalid(name, "must contain only allowed exact origins");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(name, "must contain only allowed exact origins");
  }

  if (
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    invalid(name, "must contain only allowed exact origins");
  }

  if (url.protocol === "chrome-extension:") {
    return `${url.protocol}//${url.host}`;
  }

  if (!isAllowedWebProtocol(url, nodeEnv)) {
    invalid(name, "must contain only allowed exact origins");
  }

  return url.origin;
}

function isAllowedWebProtocol(url: URL, nodeEnv: ServerNodeEnv): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  return (
    nodeEnv === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

function invalid(name: string, reason: string): never {
  throw new Error(`Invalid server environment variable ${name}: ${reason}`);
}
