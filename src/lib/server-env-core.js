// @ts-check

/** @typedef {Record<string, string | undefined>} ServerEnvSource */
/** @typedef {string | undefined} ServerNodeEnv */
/**
 * @typedef {Readonly<{
 *   databaseUrl: string,
 *   encryptionSecret: string,
 *   appAccessToken: string,
 *   appBaseUrl: string,
 *   appOrigin: string,
 *   corsAllowedOrigins: readonly string[],
 *   applicationIdentityWritesEnabled: boolean,
 * }>} ServerEnv
 */

const SECRET_PLACEHOLDER_PHRASES = [
  "any-random-string-at-least-32-characters-long",
  "example-encryption-secret-value-1234",
  "generate-a-random-32-char-string-here",
  "generate-a-random-32-character-secret-here",
  "generate-a-random-32-character-token-here",
  "generate_with_openssl_rand_base64_32",
  "replace-with-your-application-token-now",
  "replace-with-your-encryption-secret-now",
  "sample-app-access-token-value-12345",
];

const DATABASE_URL_PLACEHOLDERS = new Set([
  "postgresql://user:password@host:5432/dbname?sslmode=require",
]);

const TEMPLATE_MARKER_PATTERN = /<[^<>]+>/;

/**
 * @param {ServerEnvSource} source
 * @param {ServerNodeEnv} nodeEnv
 * @returns {ServerEnv}
 */
function parseServerEnv(source, nodeEnv) {
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
  const applicationIdentityWritesEnabled = parseOptionalBinaryFlag(
    source,
    "APPLICATION_IDENTITY_WRITES_ENABLED",
  );

  return Object.freeze({
    databaseUrl,
    encryptionSecret,
    appAccessToken,
    appBaseUrl,
    appOrigin,
    corsAllowedOrigins,
    applicationIdentityWritesEnabled,
  });
}

/** @param {ServerEnvSource} source @param {string} name @returns {boolean} */
function parseOptionalBinaryFlag(source, name) {
  const value = source[name];
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  invalid(name, 'must be exactly "0" or "1" when set');
}

/**
 * @param {ServerEnvSource} source
 * @param {ServerNodeEnv} nodeEnv
 * @returns {void}
 */
function validateServerEnv(source, nodeEnv) {
  void parseServerEnv(source, nodeEnv);
}

/**
 * @param {ServerEnvSource} source
 * @param {string} name
 * @returns {string}
 */
function required(source, name) {
  const value = source[name];
  if (value === undefined || value.length === 0) {
    invalid(name, "is required");
  }
  return value;
}

/** @param {string} value @returns {string} */
function parseDatabaseUrl(value) {
  const name = "DATABASE_URL";
  if (
    value !== value.trim() ||
    TEMPLATE_MARKER_PATTERN.test(value) ||
    DATABASE_URL_PLACEHOLDERS.has(value.toLowerCase()) ||
    value.includes("#")
  ) {
    invalid(name, "must be a valid PostgreSQL connection URL");
  }

  /** @type {URL} */
  let url;
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

/** @param {string} name @param {string} value @returns {string} */
function parseSecret(name, value) {
  const hasInvalidWhitespace =
    name === "ENCRYPTION_SECRET" ? value !== value.trim() : /\s/u.test(value);
  const normalizedValue = value.toLowerCase();
  const hasPlaceholderPhrase = SECRET_PLACEHOLDER_PHRASES.some((phrase) =>
    normalizedValue.includes(phrase),
  );

  if (
    Buffer.byteLength(value, "utf8") < 32 ||
    hasInvalidWhitespace ||
    hasPlaceholderPhrase
  ) {
    invalid(name, "must be a non-placeholder secret of at least 32 bytes");
  }
  return value;
}

/** @param {string} value @param {ServerNodeEnv} nodeEnv @returns {string} */
function parseAppOrigin(value, nodeEnv) {
  const name = "APP_BASE_URL";
  if (
    value !== value.trim() ||
    TEMPLATE_MARKER_PATTERN.test(value) ||
    /[*?#]/u.test(value)
  ) {
    invalid(name, "must be an allowed absolute application origin");
  }

  /** @type {URL} */
  let url;
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

/**
 * @param {string} value
 * @param {string} appOrigin
 * @param {ServerNodeEnv} nodeEnv
 * @returns {readonly string[]}
 */
function parseCorsOrigins(value, appOrigin, nodeEnv) {
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

/** @param {string} value @param {ServerNodeEnv} nodeEnv @returns {string} */
function parseCorsOrigin(value, nodeEnv) {
  const name = "CORS_ALLOWED_ORIGINS";
  if (
    value === "null" ||
    TEMPLATE_MARKER_PATTERN.test(value) ||
    /[*?#]/u.test(value)
  ) {
    invalid(name, "must contain only allowed exact origins");
  }

  /** @type {URL} */
  let url;
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
    if (url.port || !/^[a-p]{32}$/u.test(url.hostname)) {
      invalid(name, "must contain only allowed exact origins");
    }
    return `${url.protocol}//${url.host}`;
  }

  if (!isAllowedWebProtocol(url, nodeEnv)) {
    invalid(name, "must contain only allowed exact origins");
  }

  return url.origin;
}

/** @param {URL} url @param {ServerNodeEnv} nodeEnv @returns {boolean} */
function isAllowedWebProtocol(url, nodeEnv) {
  if (url.protocol === "https:") {
    return true;
  }
  return (
    nodeEnv === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/** @param {string} name @param {string} reason @returns {never} */
function invalid(name, reason) {
  throw new Error(`Invalid server environment variable ${name}: ${reason}`);
}

module.exports = { parseServerEnv, validateServerEnv };
