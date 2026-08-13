import "server-only";

import { prisma } from "../prisma";
import type {
  InstallationAuthenticationRecord,
  InstallationAuthenticationStore,
} from "./auth";
import type {
  ExtensionCredentialStore,
  PairingGrantRecord,
  PersistedInstallation,
} from "./extension-installations";

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

const PAIRING_CONSUMPTION_CONFLICT = Symbol("pairing-consumption-conflict");

export const extensionCredentialStore: ExtensionCredentialStore =
  Object.freeze({
    async createPairingGrant(grant: PairingGrantRecord): Promise<void> {
      await prisma.$executeRaw`
        INSERT INTO "ExtensionPairingGrant"
          ("id", "origin", "codeDigest", "expiresAt", "consumedAt",
           "installationId", "createdAt")
        VALUES
          (${grant.id}, ${grant.origin}, ${grant.codeDigest}, ${grant.expiresAt},
           NULL, NULL, ${grant.createdAt})
      `;
    },

    async findPairingGrant(id: string): Promise<PairingGrantRecord | null> {
      const rows = await prisma.$queryRaw<PairingGrantRecord[]>`
        SELECT "id", "origin", "codeDigest", "expiresAt", "consumedAt",
               "installationId", "createdAt"
        FROM "ExtensionPairingGrant"
        WHERE "id" = ${id}
        LIMIT 1
      `;
      return rows.length === 1 ? rows[0] : null;
    },

    async consumePairingGrant(input): Promise<boolean> {
      try {
        await prisma.$transaction(async (transaction) => {
          const installation = input.installation;
          await transaction.$executeRaw`
            INSERT INTO "ExtensionInstallation"
              ("id", "origin", "tokenDigest", "expiresAt", "revokedAt",
               "lastUsedAt", "createdAt", "updatedAt")
            VALUES
              (${installation.id}, ${installation.origin},
               ${installation.tokenDigest}, ${installation.expiresAt}, NULL,
               NULL, ${installation.createdAt}, ${installation.updatedAt})
          `;
          const changed = await transaction.$executeRaw`
            UPDATE "ExtensionPairingGrant"
            SET "consumedAt" = ${input.consumedAt},
                "installationId" = ${installation.id}
            WHERE "id" = ${input.grantId}
              AND "codeDigest" = ${input.expectedDigest}
              AND "consumedAt" IS NULL
              AND "expiresAt" > ${input.consumedAt}
          `;
          if (changed !== 1) throw PAIRING_CONSUMPTION_CONFLICT;
        });
        return true;
      } catch (error) {
        if (error === PAIRING_CONSUMPTION_CONFLICT) return false;
        throw error;
      }
    },

    async revoke(id: string, revokedAt: Date): Promise<boolean> {
      const changed = await prisma.$executeRaw`
        UPDATE "ExtensionInstallation"
        SET "revokedAt" = ${revokedAt}, "updatedAt" = ${revokedAt}
        WHERE "id" = ${id} AND "revokedAt" IS NULL
      `;
      return changed === 1;
    },

    async list(): Promise<readonly PersistedInstallation[]> {
      return prisma.$queryRaw<PersistedInstallation[]>`
        SELECT "id", "origin", "tokenDigest", "expiresAt", "revokedAt",
               "lastUsedAt", "createdAt", "updatedAt"
        FROM "ExtensionInstallation"
        ORDER BY "createdAt" DESC, "id" ASC
      `;
    },
  });
