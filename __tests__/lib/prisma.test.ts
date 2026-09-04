const mockAdapter = jest.fn();
const mockPrismaClient = jest.fn();
const mockPoolConfig = {
  connectionString: "postgresql://validated@127.0.0.1:5432/jobtracker_test",
  statement_timeout: 25_000,
  lock_timeout: 5_000,
};
const mockCreatePrismaPgPoolConfig = jest.fn(() => mockPoolConfig);
const mockGetServerEnv = jest.fn(() => ({
  databaseUrl: "postgresql://validated@127.0.0.1:5432/jobtracker_test",
}));

jest.mock("@prisma/adapter-pg", () => ({ PrismaPg: mockAdapter }));
jest.mock("@prisma/client", () => ({ PrismaClient: mockPrismaClient }));
jest.mock("@/lib/server-env", () => ({ getServerEnv: mockGetServerEnv }));
jest.mock("@/lib/database-timeouts", () => ({
  createPrismaPgPoolConfig: mockCreatePrismaPgPoolConfig,
}));

describe("Prisma deployment configuration", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("uses the validated database URL instead of reading process.env directly", async () => {
    process.env.DATABASE_URL =
      "postgresql://unvalidated@127.0.0.1:5432/wrong_test";

    await import("@/lib/prisma");

    expect(mockGetServerEnv).toHaveBeenCalledTimes(1);
    expect(mockCreatePrismaPgPoolConfig).toHaveBeenCalledTimes(1);
    expect(mockCreatePrismaPgPoolConfig).toHaveBeenCalledWith(
      "postgresql://validated@127.0.0.1:5432/jobtracker_test",
    );
    expect(mockAdapter).toHaveBeenCalledWith(mockPoolConfig);
  });
});
