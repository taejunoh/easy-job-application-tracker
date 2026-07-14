import { parse as parsePostgresConnectionString } from "pg-connection-string";
import { isIP } from "node:net";

type DatabaseTestEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type DatabaseTestIdentity = Readonly<{
  host: "localhost" | "127.0.0.1" | "[::1]";
  port: number;
  database: string;
  serverAddress: string;
}>;

const DESTRUCTIVE_TEST_ACKNOWLEDGEMENT = "jobtracker-ci-delete-all";
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]+_(?:ci|test)$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PARSED_CONNECTION_KEYS = new Set([
  "user",
  "password",
  "host",
  "port",
  "database",
]);

export function assertDatabaseTestSafety(
  environment: DatabaseTestEnvironment,
): DatabaseTestIdentity {
  if (environment.RUN_DATABASE_INTEGRATION !== "1") {
    refuse("RUN_DATABASE_INTEGRATION must equal 1");
  }
  if (
    environment.ALLOW_DESTRUCTIVE_DATABASE_TESTS !==
    DESTRUCTIVE_TEST_ACKNOWLEDGEMENT
  ) {
    refuse(
      "ALLOW_DESTRUCTIVE_DATABASE_TESTS must equal jobtracker-ci-delete-all",
    );
  }

  const serverAddress = environment.EXPECTED_DATABASE_SERVER_ADDRESS ?? "";
  if (serverAddress.includes("%") || isIP(serverAddress) === 0) {
    refuse("EXPECTED_DATABASE_SERVER_ADDRESS must be an explicit IP address");
  }

  const rawUrl = environment.DATABASE_URL ?? "";
  if (rawUrl.includes("\\")) {
    refuse("DATABASE_URL authority is not canonical");
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(rawUrl);
  } catch {
    refuse("DATABASE_URL must include an explicit numeric port");
  }
  if (
    databaseUrl.protocol !== "postgres:" &&
    databaseUrl.protocol !== "postgresql:"
  ) {
    refuse("DATABASE_URL must be a PostgreSQL URL");
  }
  if (databaseUrl.search || databaseUrl.hash) {
    refuse("DATABASE_URL query and hash are forbidden");
  }

  const rawTarget = rawConnectionTarget(rawUrl);
  if (
    rawTarget === null ||
    [...rawTarget.authority].filter((character) => character === "@").length >
      1 ||
    hasAmbiguousUserInfo(databaseUrl)
  ) {
    refuse("DATABASE_URL authority is not canonical");
  }

  const host = databaseUrl.hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    refuse("DATABASE_URL authority is not an allowed loopback endpoint");
  }

  const port = Number(databaseUrl.port);
  if (
    databaseUrl.port.length === 0 ||
    !/^[0-9]+$/u.test(databaseUrl.port) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    refuse("DATABASE_URL must include an explicit numeric port");
  }
  const authorityEndpoint = rawTarget.authority.slice(
    rawTarget.authority.lastIndexOf("@") + 1,
  );
  if (authorityEndpoint !== `${host}:${databaseUrl.port}`) {
    refuse("DATABASE_URL authority is not canonical");
  }

  let database: string;
  try {
    if (!/^\/[^/]+$/u.test(rawTarget.path)) {
      refuse("DATABASE_URL must contain one canonical _ci or _test database");
    }
    database = decodeURIComponent(rawTarget.path.slice(1));
  } catch {
    refuse("DATABASE_URL must contain one canonical _ci or _test database");
  }
  if (!DATABASE_NAME_PATTERN.test(database)) {
    refuse("DATABASE_URL must contain one canonical _ci or _test database");
  }

  let parsed: ReturnType<typeof parsePostgresConnectionString>;
  try {
    parsed = parsePostgresConnectionString(rawUrl);
  } catch {
    refuse("DATABASE_URL authority is not canonical");
  }
  if (
    parsed.host !== host ||
    parsed.port !== databaseUrl.port ||
    parsed.database !== database ||
    Object.keys(parsed).some((key) => !PARSED_CONNECTION_KEYS.has(key))
  ) {
    refuse("DATABASE_URL effective connection target is not canonical");
  }

  return Object.freeze({
    host: host as DatabaseTestIdentity["host"],
    port,
    database,
    serverAddress,
  });
}

function rawConnectionTarget(
  rawUrl: string,
): Readonly<{ authority: string; path: string }> | null {
  const match = rawUrl.match(
    /^postgres(?:ql)?:\/\/([^/?#]+)(\/[^?#]*)$/u,
  );
  return match === null
    ? null
    : Object.freeze({ authority: match[1], path: match[2] });
}

function hasAmbiguousUserInfo(url: URL): boolean {
  try {
    return /[@/?#\\]/u.test(
      `${decodeURIComponent(url.username)}${decodeURIComponent(url.password)}`,
    );
  } catch {
    return true;
  }
}

function refuse(reason: string): never {
  throw new Error(`Refusing destructive database integration tests: ${reason}`);
}
