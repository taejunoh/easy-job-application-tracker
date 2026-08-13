import "server-only";

import { prisma } from "../prisma";
import type {
  InstallationAuthenticationRecord,
  InstallationAuthenticationStore,
} from "./auth";

export const extensionInstallationAuthenticationStore: InstallationAuthenticationStore =
  Object.freeze({
    async findForAuthentication(
      selector: string,
    ): Promise<InstallationAuthenticationRecord | null> {
      const rows = await prisma.$queryRaw<InstallationAuthenticationRecord[]>`
        SELECT "id", "origin", "tokenDigest", "expiresAt", "revokedAt"
        FROM "ExtensionInstallation"
        WHERE "id" = ${selector}
        LIMIT 1
      `;
      return rows.length === 1 ? rows[0] : null;
    },

    async touch(id: string, usedAt: Date): Promise<boolean> {
      const changed = await prisma.$executeRaw`
        UPDATE "ExtensionInstallation"
        SET "lastUsedAt" = ${usedAt}, "updatedAt" = ${usedAt}
        WHERE "id" = ${id}
          AND "revokedAt" IS NULL
          AND "expiresAt" > ${usedAt}
      `;
      return changed === 1;
    },
  });
