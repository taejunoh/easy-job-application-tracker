import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool, PoolClient } from "pg";
import { assertDatabaseTestSafety } from "../api/database-test-guard";
import {
  verifyLiveDatabaseIdentity,
  type DatabaseTestIdentity,
} from "../api/database-test-preflight";
import { createPrismaPgPoolConfig } from "@/lib/database-timeouts";

const DATABASE_INTEGRATION_REQUESTED =
  process.env.RUN_DATABASE_INTEGRATION === "1";
const DATABASE_TEST_IDENTITY: DatabaseTestIdentity | undefined =
  DATABASE_INTEGRATION_REQUESTED
    ? assertDatabaseTestSafety(process.env)
    : undefined;
const describeDatabase = DATABASE_INTEGRATION_REQUESTED
  ? describe
  : describe.skip;

type TimeoutObservation = Readonly<{
  pid: number;
  statement: string;
  lock: string;
}>;

describeDatabase("PrismaPg PostgreSQL startup timeouts", () => {
  let factory: PrismaPg | undefined;
  let adapter: Awaited<ReturnType<PrismaPg["connect"]>> | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    factory = new PrismaPg(
      createPrismaPgPoolConfig(process.env.DATABASE_URL ?? ""),
    );
    adapter = await factory.connect();
    pool = adapter.underlyingDriver();

    await verifyLiveDatabaseIdentity(
      {
        $queryRawUnsafe: async (query: string) => {
          const result = await pool!.query(query);
          return result.rows;
        },
      },
      DATABASE_TEST_IDENTITY!,
    );
  });

  afterAll(async () => {
    await adapter?.dispose();
  });

  test("proves all ten PrismaPg-owned pool clients use PostgreSQL 17 and startup timeouts", async () => {
    const activePool = pool!;

    expect(activePool.options.max).toBe(10);

    const versionResult = await activePool.query<{
      server_version_num: string;
    }>("SHOW server_version_num");
    const serverVersion = Number(versionResult.rows[0]?.server_version_num);
    expect(serverVersion).toBeGreaterThanOrEqual(170_000);
    expect(serverVersion).toBeLessThan(180_000);

    const connectionPromises = Array.from({ length: 10 }, () =>
      activePool.connect(),
    );
    try {
      const clients = await Promise.all(connectionPromises);
      const observations = await Promise.all(
        clients.map(async (client): Promise<TimeoutObservation> => {
          const pidResult = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          );
          const statementResult = await client.query<{
            statement_timeout: string;
          }>("SHOW statement_timeout");
          const lockResult = await client.query<{ lock_timeout: string }>(
            "SHOW lock_timeout",
          );

          return {
            pid: Number(pidResult.rows[0]?.pid),
            statement: statementResult.rows[0]?.statement_timeout ?? "",
            lock: lockResult.rows[0]?.lock_timeout ?? "",
          };
        }),
      );

      expect(observations).toHaveLength(10);
      expect(
        observations.every(
          ({ pid }) => Number.isInteger(pid) && Number.isFinite(pid),
        ),
      ).toBe(true);
      expect(new Set(observations.map(({ pid }) => pid)).size).toBe(10);
      expect(
        observations.every(
          ({ statement, lock }) =>
            statement === "25s" && lock === "5s",
        ),
      ).toBe(true);
      expect(observations.map(({ statement, lock }) => ({ statement, lock }))).toEqual(
        Array.from({ length: 10 }, () => ({ statement: "25s", lock: "5s" })),
      );
    } finally {
      const acquiredClients = (await Promise.allSettled(connectionPromises))
        .flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
      await Promise.all(acquiredClients.map((client: PoolClient) => client.release()));
    }
  });
});
