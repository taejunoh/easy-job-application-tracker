import { assertDatabaseTestSafety } from "./database-test-guard";

const safeEnvironment = {
  RUN_DATABASE_INTEGRATION: "1",
  ALLOW_DESTRUCTIVE_DATABASE_TESTS: "jobtracker-ci-delete-all",
  DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/jobtracker_ci",
};

describe("destructive database integration guard", () => {
  it.each([
    [
      "postgresql://postgres@localhost:5432/jobtracker_ci",
      { host: "localhost", port: 5432, database: "jobtracker_ci" },
    ],
    [
      "postgresql://postgres@127.0.0.1:6543/jobtracker_test",
      { host: "127.0.0.1", port: 6543, database: "jobtracker_test" },
    ],
    [
      "postgresql://postgres@[::1]:5432/jobtracker_ci",
      { host: "[::1]", port: 5432, database: "jobtracker_ci" },
    ],
  ])("returns the effective identity for %s", (url, expected) => {
    expect(
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toEqual(expected);
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
    "postgresql://postgres@evil.example:5432/jobtracker_ci",
    "postgresql://postgres@2130706433:5432/jobtracker_ci",
    "postgresql://postgres@localhost.:5432/jobtracker_ci",
  ])("rejects a non-loopback effective host: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toThrow("DATABASE_URL authority is not an allowed loopback endpoint");
  });

  it.each([
    "postgresql://postgres@127.0.0.1/jobtracker_ci",
    "postgresql://postgres@127.0.0.1:port/jobtracker_ci",
    "postgresql://postgres@127.0.0.1:0/jobtracker_ci",
    "postgresql://postgres@127.0.0.1:65536/jobtracker_ci",
  ])("requires an explicit valid numeric port: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toThrow("DATABASE_URL must include an explicit numeric port");
  });

  it.each([
    "postgresql://postgres@127.0.0.1:5432/jobtracker",
    "postgresql://postgres@127.0.0.1:5432/jobtracker_ci_shadow",
    "postgresql://postgres@127.0.0.1:5432/job-tracker_ci",
    "postgresql://postgres@127.0.0.1:5432/jobtracker%2F_ci",
    "postgresql://postgres@127.0.0.1:5432/team/jobtracker_ci",
    "postgresql://postgres@127.0.0.1:5432/team/../jobtracker_ci",
    "postgresql://postgres@127.0.0.1:5432/%2e%2e/jobtracker_ci",
    "postgresql://postgres@127.0.0.1:5432/%E0%A4%A",
  ])("rejects a non-canonical disposable database path: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toThrow("DATABASE_URL must contain one canonical _ci or _test database");
  });

  it.each([
    "?host=evil.example",
    "?hostaddr=203.0.113.8",
    "?options=-c%20search_path%3Devil",
    "?search_path=evil",
    "?sslmode=require",
    "?service=production",
    "?port=6543",
  ])("rejects every connection query option: %s", (suffix) => {
    expect(() =>
      assertDatabaseTestSafety({
        ...safeEnvironment,
        DATABASE_URL: `${safeEnvironment.DATABASE_URL}${suffix}`,
      }),
    ).toThrow("DATABASE_URL query and hash are forbidden");
  });

  it("rejects URL fragments", () => {
    expect(() =>
      assertDatabaseTestSafety({
        ...safeEnvironment,
        DATABASE_URL: `${safeEnvironment.DATABASE_URL}#production`,
      }),
    ).toThrow("DATABASE_URL query and hash are forbidden");
  });

  it.each([
    "postgresql://user%40evil:pass@127.0.0.1:5432/jobtracker_ci",
    "postgresql://user:pass%2Fword@127.0.0.1:5432/jobtracker_ci",
    "postgresql://user:pass@evil.example@127.0.0.1:5432/jobtracker_ci",
    "postgresql://user:pass\\@evil.example:5432/jobtracker_ci",
    "postgresql://user:pass@[0:0:0:0:0:0:0:1]:5432/jobtracker_ci",
  ])("rejects ambiguous userinfo authority syntax: %s", (url) => {
    expect(() =>
      assertDatabaseTestSafety({ ...safeEnvironment, DATABASE_URL: url }),
    ).toThrow("DATABASE_URL authority is not canonical");
  });

  it("does not expose database credentials in guard errors", () => {
    const secretUrl =
      "postgresql://fixture-user:private-password@remote.example:5432/jobtracker_ci";

    try {
      assertDatabaseTestSafety({
        ...safeEnvironment,
        DATABASE_URL: secretUrl,
      });
      throw new Error("expected database guard rejection");
    } catch (error) {
      expect(String(error)).toContain("Refusing destructive database");
      expect(String(error)).not.toContain("private-password");
    }
  });
});
