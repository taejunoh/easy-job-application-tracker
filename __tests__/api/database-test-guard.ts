type DatabaseTestEnvironment = Readonly<
  Record<string, string | undefined>
>;

const DESTRUCTIVE_TEST_ACKNOWLEDGEMENT = "jobtracker-ci-delete-all";

export function assertDatabaseTestSafety(
  environment: DatabaseTestEnvironment,
): void {
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

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(environment.DATABASE_URL ?? "");
  } catch {
    refuse("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    databaseUrl.protocol !== "postgres:" &&
    databaseUrl.protocol !== "postgresql:"
  ) {
    refuse("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    databaseUrl.hostname !== "localhost" &&
    databaseUrl.hostname !== "127.0.0.1"
  ) {
    refuse("DATABASE_URL host must be localhost or 127.0.0.1");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  } catch {
    refuse("DATABASE_URL database name must end in _ci or _test");
  }
  if (!databaseName.endsWith("_ci") && !databaseName.endsWith("_test")) {
    refuse("DATABASE_URL database name must end in _ci or _test");
  }
}

function refuse(reason: string): never {
  throw new Error(`Refusing destructive database integration tests: ${reason}`);
}
