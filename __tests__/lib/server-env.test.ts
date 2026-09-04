import { getServerEnv, parseServerEnv } from "@/lib/server-env";

const productionSource = {
  DATABASE_URL:
    "postgresql://jobtracker:database-password@db.example.com:5432/jobtracker?sslmode=require",
  ENCRYPTION_SECRET: "e".repeat(32),
  APP_ACCESS_TOKEN: "t".repeat(32),
  APP_BASE_URL: "https://jobs.example.com/",
  CORS_ALLOWED_ORIGINS:
    "https://jobs.example.com,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  APPLICATION_IDENTITY_WRITES_ENABLED: "1",
  APPLICATION_WRITES_ENABLED: "1",
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
      applicationIdentityWritesEnabled: true,
      applicationWritesEnabled: true,
    });
    expect(config).not.toHaveProperty("corsAllowedOriginSet");
    expect(Object.isFrozen(config.corsAllowedOrigins)).toBe(true);
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

  it.each([
    [
      "https://bücher.example/",
      "https://bücher.example",
      "https://xn--bcher-kva.example",
    ],
    [
      "https://[2001:db8::1]/",
      "https://[2001:db8::1]",
      "https://[2001:db8::1]",
    ],
    [
      "https://jobs.example.com:443/",
      "https://jobs.example.com:443",
      "https://jobs.example.com",
    ],
  ])("normalizes the application and CORS origin %s", (baseUrl, cors, origin) => {
    const config = parseServerEnv(
      {
        ...productionSource,
        APP_BASE_URL: baseUrl,
        CORS_ALLOWED_ORIGINS: cors,
      },
      "production",
    );

    expect(config.appOrigin).toBe(origin);
    expect(config.corsAllowedOrigins).toEqual([origin]);
  });

  it("accepts legitimate values containing placeholder-like words", () => {
    const origin = "https://your.company.com";
    const secret = "your-example-change-value-" + "x".repeat(32);
    const config = parseServerEnv(
      {
        ...productionSource,
        ENCRYPTION_SECRET: secret,
        APP_ACCESS_TOKEN: secret,
        APP_BASE_URL: origin,
        CORS_ALLOWED_ORIGINS: origin,
      },
      "production",
    );

    expect(config.appOrigin).toBe(origin);
  });

  it("defaults application identity writes off and accepts only exact binary values", () => {
    const disabled = parseServerEnv({
      ...productionSource,
      APPLICATION_IDENTITY_WRITES_ENABLED: undefined,
    }, "production");
    const explicitDisabled = parseServerEnv({
      ...productionSource,
      APPLICATION_IDENTITY_WRITES_ENABLED: "0",
    }, "production");

    expect(disabled.applicationIdentityWritesEnabled).toBe(false);
    expect(explicitDisabled.applicationIdentityWritesEnabled).toBe(false);
    for (const value of ["true", "yes", " 1", "1 ", "2"]) {
      expect(() => parseServerEnv({
        ...productionSource,
        APPLICATION_IDENTITY_WRITES_ENABLED: value,
      }, "production")).toThrow("APPLICATION_IDENTITY_WRITES_ENABLED");
    }
  });

  it("defaults application writes off and accepts only exact binary values", () => {
    const disabled = parseServerEnv({
      ...productionSource,
      APPLICATION_WRITES_ENABLED: undefined,
    }, "production");
    const explicitDisabled = parseServerEnv({
      ...productionSource,
      APPLICATION_WRITES_ENABLED: "0",
    }, "production");
    const enabled = parseServerEnv({
      ...productionSource,
      APPLICATION_WRITES_ENABLED: "1",
    }, "production");

    expect(disabled.applicationWritesEnabled).toBe(false);
    expect(explicitDisabled.applicationWritesEnabled).toBe(false);
    expect(enabled.applicationWritesEnabled).toBe(true);
    for (const value of ["true", "yes", " 1 ", "2", ""]) {
      expect(() => parseServerEnv({
        ...productionSource,
        APPLICATION_WRITES_ENABLED: value,
      }, "production")).toThrow("APPLICATION_WRITES_ENABLED");
    }
  });

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
    "postgresql://jobtracker:secure-db-password@db.example.com/jobtracker#fragment",
  ])("rejects malformed or placeholder DATABASE_URL %s", (databaseUrl) => {
    expectInvalidWithoutValue("DATABASE_URL", databaseUrl, {
      DATABASE_URL: databaseUrl,
    });
  });

  it("accepts a non-placeholder database URL with a conventional username", () => {
    const databaseUrl =
      "postgresql://user:secure-password@db.company.com/jobtracker";

    const config = parseServerEnv(
      { ...productionSource, DATABASE_URL: databaseUrl },
      "production",
    );

    expect(config.databaseUrl).toBe(databaseUrl);
  });

  it.each([
    "statement_timeout=1",
    "STATEMENT_TIMEOUT=1",
    "lock_timeout=1",
    "LOCK_TIMEOUT=1",
    "options=-c%20statement_timeout%3D0",
    "OPTIONS=-c%20lock_timeout%3D0",
    "statement_timeout=1&statement_timeout=2",
    "Statement_Timeout=1&statement_timeout=2",
    "lock_timeout=1&lock_timeout=2",
    "Lock_Timeout=1&lock_timeout=2",
    "options=one&options=two",
    "Options=one&options=two",
  ])("rejects reserved PostgreSQL timeout URL query %s", (query) => {
    const databaseUrl =
      `postgresql://jobtracker:database-password@db.example.com:5432/jobtracker?${query}`;

    expectInvalidWithoutValue(
      "DATABASE_URL",
      databaseUrl,
      { DATABASE_URL: databaseUrl },
      "production",
      "must not contain reserved PostgreSQL timeout parameters",
    );
  });

  it("accepts supported non-timeout PostgreSQL URL query parameters unchanged", () => {
    const databaseUrl =
      "postgresql://jobtracker:database-password@db.example.com:5432/jobtracker?sslmode=require&sslcert=client-cert.pem&sslkey=client-key.pem&sslrootcert=ca.pem&schema=public&application_name=jobtracker";

    const config = parseServerEnv(
      { ...productionSource, DATABASE_URL: databaseUrl },
      "production",
    );

    expect(config.databaseUrl).toBe(databaseUrl);
  });

  it.each(["short", " ".repeat(32), "é".repeat(15) + "a"])(
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
    "any-random-string-at-least-32-characters-long",
    "GENERATE_WITH_OPENSSL_RAND_BASE64_32",
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
    "generate_with_openssl_rand_base64_32",
  ])("rejects placeholder APP_ACCESS_TOKEN values", (appAccessToken) => {
    expectInvalidWithoutValue("APP_ACCESS_TOKEN", appAccessToken, {
      APP_ACCESS_TOKEN: appAccessToken,
    });
  });

  it.each(["ENCRYPTION_SECRET", "APP_ACCESS_TOKEN"] as const)(
    "rejects known placeholder phrases embedded in %s",
    (name) => {
      for (const value of [
        "GENERATE_WITH_OPENSSL_RAND_BASE64_32!",
        "prefix-any-random-string-at-least-32-characters-long-1",
      ]) {
        expectInvalidWithoutValue(name, value, { [name]: value });
      }
    },
  );

  it("accepts a long ENCRYPTION_SECRET with internal spaces", () => {
    const encryptionSecret = "valid encryption secret with spaces 1234567890";

    const config = parseServerEnv(
      { ...productionSource, ENCRYPTION_SECRET: encryptionSecret },
      "production",
    );

    expect(config.encryptionSecret).toBe(encryptionSecret);
  });

  it.each(["ENCRYPTION_SECRET", "APP_ACCESS_TOKEN"] as const)(
    "accepts an unrelated angle-bracket segment in %s",
    (name) => {
      const value = "valid-<segment>-secret-material-1234567890";

      const config = parseServerEnv(
        { ...productionSource, [name]: value },
        "production",
      );

      const configKey =
        name === "ENCRYPTION_SECRET" ? "encryptionSecret" : "appAccessToken";
      expect(config[configKey]).toBe(value);
    },
  );

  it.each(["ENCRYPTION_SECRET", "APP_ACCESS_TOKEN"] as const)(
    "rejects leading, trailing, and whitespace-only %s values",
    (name) => {
      for (const value of [
        ` ${"x".repeat(32)}`,
        `${"x".repeat(32)} `,
        " ".repeat(32),
      ]) {
        expectInvalidWithoutValue(name, value, { [name]: value });
      }
    },
  );

  it.each(["ENCRYPTION_SECRET", "APP_ACCESS_TOKEN"] as const)(
    "rejects a 31-byte %s and accepts a 32-byte multibyte value",
    (name) => {
      const thirtyOneBytes = "é".repeat(15) + "a";
      const thirtyTwoBytes = "é".repeat(16);

      expectInvalidWithoutValue(name, thirtyOneBytes, { [name]: thirtyOneBytes });
      expect(() =>
        parseServerEnv(
          { ...productionSource, [name]: thirtyTwoBytes },
          "production",
        ),
      ).not.toThrow();
    },
  );

  it.each([
    "not-a-url",
    "http://jobs.example.com",
    "https://jobs.example.com/app",
    "https://jobs.example.com/?mode=hosted",
    "https://jobs.example.com/#dashboard",
    "https://jobs.example.com/?",
    "https://jobs.example.com/#",
    "https://owner@jobs.example.com/",
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
    "https://jobs.example.com?",
    "https://jobs.example.com#",
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

  it.each(["https://*.example.com", "chrome-extension://*"])(
    "rejects wildcard origin %s",
    (wildcardOrigin) => {
      const origins = `https://jobs.example.com,${wildcardOrigin}`;

      expectInvalidWithoutValue("CORS_ALLOWED_ORIGINS", origins, {
        CORS_ALLOWED_ORIGINS: origins,
      });
    },
  );

  it.each([
    "chrome-extension://example.com",
    `chrome-extension://${"a".repeat(32)}:123`,
    `chrome-extension://${"a".repeat(31)}`,
    `chrome-extension://${"a".repeat(33)}`,
    `chrome-extension://${"a".repeat(31)}q`,
    `chrome-extension://${"A".repeat(32)}`,
  ])("rejects malformed Chrome extension origin %s", (extensionOrigin) => {
    const origins = `https://jobs.example.com,${extensionOrigin}`;

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
  expectedMessage?: string,
): void {
  try {
    parseServerEnv({ ...productionSource, ...overrides }, nodeEnv);
    throw new Error("Expected parseServerEnv to reject the configuration");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(variableName);
    expect((error as Error).message).not.toContain(invalidValue);
    if (expectedMessage !== undefined) {
      expect((error as Error).message).toContain(expectedMessage);
    }
  }
}
