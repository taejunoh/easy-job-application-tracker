import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { createPrismaPgPoolConfig } from "./database-timeouts";
import { getServerEnv } from "./server-env";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(
    createPrismaPgPoolConfig(getServerEnv().databaseUrl),
  );
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
