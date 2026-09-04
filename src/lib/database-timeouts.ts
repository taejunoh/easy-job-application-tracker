import type pg from "pg";

export const POSTGRES_STATEMENT_TIMEOUT_MS = 25_000;
export const POSTGRES_LOCK_TIMEOUT_MS = 5_000;

export function createPrismaPgPoolConfig(
  connectionString: string,
): pg.PoolConfig {
  return {
    connectionString,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
  };
}
