import { assertDatabaseTestSafety } from "./database-test-guard";

const safeEnvironment = {
  RUN_DATABASE_INTEGRATION: "1",
  ALLOW_DESTRUCTIVE_DATABASE_TESTS: "jobtracker-ci-delete-all",
  DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/jobtracker_ci",
};

describe("destructive database integration guard", () => {
  it.each([
    "postgresql://postgres@localhost:5432/jobtracker_ci",
    "postgresql://postgres@127.0.0.1:5432/jobtracker_test",
    "postgresql://postgres@127.0.0.1:5432/jobtracker%5Fci",
  ])("accepts an explicitly authorized local disposable database: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).not.toThrow();
  });

  it.each([undefined, "", "true", "0"])(
    "rejects an invalid run flag %j",
    (value) => {
      expect(() =>
        assertDatabaseTestSafety({
          ...safeEnvironment,
          RUN_DATABASE_INTEGRATION: value,
        }),
      ).toThrow("RUN_DATABASE_INTEGRATION must equal 1");
    },
  );

  it.each([undefined, "", "yes", "jobtracker-ci-delete"])(
    "rejects an invalid destructive-test acknowledgement %j",
    (value) => {
      expect(() =>
        assertDatabaseTestSafety({
          ...safeEnvironment,
          ALLOW_DESTRUCTIVE_DATABASE_TESTS: value,
        }),
      ).toThrow(
        "ALLOW_DESTRUCTIVE_DATABASE_TESTS must equal jobtracker-ci-delete-all",
      );
    },
  );

  it.each([
    "postgresql://postgres@db:5432/jobtracker_ci",
    "postgresql://postgres@192.168.1.10:5432/jobtracker_ci",
    "postgresql://postgres@[::1]:5432/jobtracker_ci",
  ])("rejects a non-allowlisted database host: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toThrow("DATABASE_URL host must be localhost or 127.0.0.1");
  });

  it.each([
    "postgresql://postgres@127.0.0.1:5432/jobtracker",
    "postgresql://postgres@127.0.0.1:5432/jobtracker_ci_shadow",
    "postgresql://postgres@127.0.0.1:5432/jobtracker%2Fci",
  ])("rejects a database name without a decoded disposable suffix: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toThrow("DATABASE_URL database name must end in _ci or _test");
  });

  it("does not expose database credentials in guard errors", () => {
    const secretUrl =
      "postgresql://fixture-user:private-password@remote.example/jobtracker_ci";

    expect(() =>
      assertDatabaseTestSafety({
        ...safeEnvironment,
        DATABASE_URL: secretUrl,
      }),
    ).toThrow("DATABASE_URL host must be localhost or 127.0.0.1");

    try {
      assertDatabaseTestSafety({
        ...safeEnvironment,
        DATABASE_URL: secretUrl,
      });
    } catch (error) {
      expect(String(error)).not.toContain("private-password");
    }
  });
});
