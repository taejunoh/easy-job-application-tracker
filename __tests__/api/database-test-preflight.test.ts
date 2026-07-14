import {
  resetVerifiedIntegrationDatabase,
  verifyLiveDatabaseIdentity,
  type DatabaseTestIdentity,
} from "./database-test-preflight";

const expected: DatabaseTestIdentity = {
  host: "127.0.0.1",
  port: 5432,
  database: "jobtracker_ci",
  serverAddress: "127.0.0.1",
};

describe("live destructive database identity preflight", () => {
  it.each(["127.0.0.1", "172.18.0.3"])(
    "accepts only the exact expected server address %s",
    async (address) => {
      const identity = { ...expected, serverAddress: address };
      const database = fakeDatabase({ address });

      await expect(verifyLiveDatabaseIdentity(database, identity)).resolves.toEqual({
        database: "jobtracker_ci",
        address,
        port: 5432,
        schema: "public",
      });
      expect(database.$queryRawUnsafe).toHaveBeenCalledWith(
        "SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, current_schema() AS schema",
      );
    },
  );

  it.each([
    ["database", { database: "production" }],
    ["server address", { address: "203.0.113.8" }],
    ["socket connection", { address: null }],
    ["server port", { port: 6543 }],
    ["schema", { schema: "private" }],
  ])("rejects a mismatched live %s before mutation", async (_name, override) => {
    const database = fakeDatabase(override);

    await expect(
      resetVerifiedIntegrationDatabase(database, expected),
    ).rejects.toThrow("Live database identity does not match destructive-test target");
    expect(database.application.deleteMany).not.toHaveBeenCalled();
    expect(database.settings.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a different private bridge address before every mutation", async () => {
    const identity = { ...expected, serverAddress: "172.18.0.3" };
    const database = fakeDatabase({ address: "172.18.0.4" });

    await expect(
      resetVerifiedIntegrationDatabase(database, identity),
    ).rejects.toThrow("Live database identity does not match destructive-test target");
    expect(database.application.deleteMany).not.toHaveBeenCalled();
    expect(database.settings.deleteMany).not.toHaveBeenCalled();
  });

  it("runs both cleanup mutations only after identity verification", async () => {
    const database = fakeDatabase();

    const identity = await resetVerifiedIntegrationDatabase(database, expected);

    expect(identity.database).toBe(expected.database);
    expect(database.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(database.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      database.application.deleteMany.mock.invocationCallOrder[0],
    );
    expect(database.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      database.settings.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("rejects missing or duplicate identity rows before mutation", async () => {
    for (const rows of [[], [liveRow(), liveRow()]]) {
      const database = fakeDatabase();
      database.$queryRawUnsafe.mockResolvedValueOnce(rows);

      await expect(
        resetVerifiedIntegrationDatabase(database, expected),
      ).rejects.toThrow("Live database identity does not match destructive-test target");
      expect(database.application.deleteMany).not.toHaveBeenCalled();
      expect(database.settings.deleteMany).not.toHaveBeenCalled();
    }
  });
});

function liveRow(
  override: Partial<{
    database: string;
    address: string | null;
    port: number;
    schema: string;
  }> = {},
) {
  return {
    database: "jobtracker_ci",
    address: "127.0.0.1",
    port: 5432,
    schema: "public",
    ...override,
  };
}

function fakeDatabase(override: Parameters<typeof liveRow>[0] = {}) {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([liveRow(override)]),
    application: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    settings: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
}
