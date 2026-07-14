import { getServerEnv, parseServerEnv } from "@/lib/server-env";

const productionSource = {
  DATABASE_URL:
    "postgresql://jobtracker:database-password@db.example.com:5432/jobtracker?sslmode=require",
  ENCRYPTION_SECRET: "e".repeat(32),
  APP_ACCESS_TOKEN: "t".repeat(32),
  APP_BASE_URL: "https://jobs.example.com/",
  CORS_ALLOWED_ORIGINS:
    "https://jobs.example.com,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
};

describe("parseServerEnv", () => {
  it("parses and normalizes a valid production configuration", () => {
    const config = parseServerEnv(productionSource, "production");

    expect(config).toMatchObject({
      databaseUrl: productionSource.DATABASE_URL,
      encryptionSecret: productionSource.ENCRYPTION_SECRET,
      appAccessToken: productionSource.APP_ACCESS_TOKEN,
      appBaseUrl: productionSource.APP_BASE_URL,
      appOrigin: "https://jobs.example.com",
      corsAllowedOrigins: [
        "https://jobs.example.com",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      ],
    });
    expect(config.corsAllowedOriginSet).toEqual(
      new Set(config.corsAllowedOrigins),
    );
  });

  it.each(["localhost", "127.0.0.1"])(
    "accepts an HTTP %s origin in development",
    (hostname) => {
      const appOrigin = `http://${hostname}:3000`;
      const config = parseServerEnv(
        {
          ...productionSource,
          APP_BASE_URL: `${appOrigin}/`,
          CORS_ALLOWED_ORIGINS: `${appOrigin}/`,
        },
        "development",
      );

      expect(config.appOrigin).toBe(appOrigin);
      expect(config.corsAllowedOrigins).toEqual([appOrigin]);
    },
  );

  it.each(["production", "test", "staging"])(
    "rejects local HTTP origins outside development (%s)",
    (nodeEnv) => {
      const appOrigin = "http://localhost:3000";

      expectInvalidWithoutValue(
        "APP_BASE_URL",
        appOrigin,
        {
          APP_BASE_URL: appOrigin,
          CORS_ALLOWED_ORIGINS: appOrigin,
        },
        nodeEnv,
      );
    },
  );

  it.each([
    "DATABASE_URL",
    "ENCRYPTION_SECRET",
    "APP_ACCESS_TOKEN",
    "APP_BASE_URL",
    "CORS_ALLOWED_ORIGINS",
  ] as const)("rejects a missing %s", (name) => {
    const source = { ...productionSource, [name]: undefined };

    expect(() => parseServerEnv(source, "production")).toThrow(name);
  });

  it.each([
    "not-a-url",
    "mysql://user:password@db.example.com/jobtracker",
    "postgresql:///jobtracker",
    "postgresql://db.example.com",
    "postgresql://user:password@host:5432/dbname?sslmode=require",
    "postgresql://replace-me:replace-me@db.example.com/jobtracker",
  ])("rejects malformed or placeholder DATABASE_URL %s", (databaseUrl) => {
    expectInvalidWithoutValue("DATABASE_URL", databaseUrl, {
      DATABASE_URL: databaseUrl,
    });
  });

  it.each(["short", " ".repeat(32), "é".repeat(15)])(
    "rejects weak ENCRYPTION_SECRET values",
    (encryptionSecret) => {
      expectInvalidWithoutValue("ENCRYPTION_SECRET", encryptionSecret, {
        ENCRYPTION_SECRET: encryptionSecret,
      });
    },
  );

  it.each([
    "generate-a-random-32-character-secret-here",
    "replace-with-your-encryption-secret-now",
    "example-encryption-secret-value-1234",
  ])("rejects placeholder ENCRYPTION_SECRET values", (encryptionSecret) => {
    expectInvalidWithoutValue("ENCRYPTION_SECRET", encryptionSecret, {
      ENCRYPTION_SECRET: encryptionSecret,
    });
  });

  it.each(["short", " ".repeat(32), "a".repeat(16) + " " + "b".repeat(16)])(
    "rejects weak APP_ACCESS_TOKEN values",
    (appAccessToken) => {
      expectInvalidWithoutValue("APP_ACCESS_TOKEN", appAccessToken, {
        APP_ACCESS_TOKEN: appAccessToken,
      });
    },
  );

  it.each([
    "generate-a-random-32-character-token-here",
    "replace-with-your-application-token-now",
    "sample-app-access-token-value-12345",
  ])("rejects placeholder APP_ACCESS_TOKEN values", (appAccessToken) => {
    expectInvalidWithoutValue("APP_ACCESS_TOKEN", appAccessToken, {
      APP_ACCESS_TOKEN: appAccessToken,
    });
  });

  it.each([
    "not-a-url",
    "http://jobs.example.com",
    "https://jobs.example.com/app",
    "https://jobs.example.com/?mode=hosted",
    "https://jobs.example.com/#dashboard",
    "https://owner@jobs.example.com/",
    "https://your-app.example.com/",
  ])("rejects malformed production APP_BASE_URL %s", (appBaseUrl) => {
    expectInvalidWithoutValue("APP_BASE_URL", appBaseUrl, {
      APP_BASE_URL: appBaseUrl,
      CORS_ALLOWED_ORIGINS: "https://jobs.example.com",
    });
  });

  it.each([
    "http://jobs.example.com",
    "http://0.0.0.0:3000",
    "http://[::1]:3000",
  ])("rejects non-local HTTP APP_BASE_URL in development %s", (appBaseUrl) => {
    expectInvalidWithoutValue(
      "APP_BASE_URL",
      appBaseUrl,
      {
        APP_BASE_URL: appBaseUrl,
        CORS_ALLOWED_ORIGINS: appBaseUrl,
      },
      "development",
    );
  });

  it.each([
    "*",
    "null",
    "https://jobs.example.com/app",
    "https://jobs.example.com?mode=hosted",
    "https://jobs.example.com#dashboard",
    "https://owner@jobs.example.com",
    "http://localhost:3000",
  ])("rejects invalid production CORS_ALLOWED_ORIGINS %s", (allowedOrigin) => {
    expectInvalidWithoutValue("CORS_ALLOWED_ORIGINS", allowedOrigin, {
      CORS_ALLOWED_ORIGINS: allowedOrigin,
    });
  });

  it("rejects duplicate normalized CORS origins", () => {
    const origins = "https://jobs.example.com,https://jobs.example.com/";

    expectInvalidWithoutValue("CORS_ALLOWED_ORIGINS", origins, {
      CORS_ALLOWED_ORIGINS: origins,
    });
  });

  it("rejects placeholder origins within CORS_ALLOWED_ORIGINS", () => {
    const origins =
      "https://jobs.example.com,https://your-extension-origin.example.com";

    expectInvalidWithoutValue("CORS_ALLOWED_ORIGINS", origins, {
      CORS_ALLOWED_ORIGINS: origins,
    });
  });

  it("requires CORS_ALLOWED_ORIGINS to contain the app origin", () => {
    const origins = "https://other.example.com";

    expectInvalidWithoutValue("CORS_ALLOWED_ORIGINS", origins, {
      CORS_ALLOWED_ORIGINS: origins,
    });
  });
});

describe("getServerEnv", () => {
  it("parses process.env lazily once and returns the cached configuration", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, ...productionSource, NODE_ENV: "production" };

    try {
      const first = getServerEnv();
      process.env.APP_BASE_URL = "invalid-after-first-read";
      const second = getServerEnv();

      expect(second).toBe(first);
      expect(second.appOrigin).toBe("https://jobs.example.com");
    } finally {
      process.env = originalEnv;
    }
  });
});

function expectInvalidWithoutValue(
  variableName: string,
  invalidValue: string,
  overrides: Partial<typeof productionSource>,
  nodeEnv: string | undefined = "production",
): void {
  try {
    parseServerEnv({ ...productionSource, ...overrides }, nodeEnv);
    throw new Error("Expected parseServerEnv to reject the configuration");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(variableName);
    expect((error as Error).message).not.toContain(invalidValue);
  }
}
