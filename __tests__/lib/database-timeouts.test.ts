import {
  createPrismaPgPoolConfig,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "@/lib/database-timeouts";

describe("Prisma PostgreSQL timeout factory", () => {
  it("returns exact settings and leaves the URL unchanged", () => {
    const connectionString =
      "postgresql://user:password@db.example.com:5432/jobtracker?sslmode=require&schema=public";

    expect(createPrismaPgPoolConfig(connectionString)).toEqual({
      connectionString,
      statement_timeout: 25_000,
      lock_timeout: 5_000,
    });
    expect(POSTGRES_STATEMENT_TIMEOUT_MS).toBe(25_000);
    expect(POSTGRES_LOCK_TIMEOUT_MS).toBe(5_000);
  });

  it("does not read process.env", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://wrong@127.0.0.1:5432/wrong_test";
    const connectionString =
      "postgresql://validated@127.0.0.1:5432/validated_test";

    try {
      expect(createPrismaPgPoolConfig(connectionString).connectionString).toBe(
        connectionString,
      );
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});
