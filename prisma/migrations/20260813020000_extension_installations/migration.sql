-- Create installation-scoped extension credentials without changing legacy data.
CREATE TABLE "ExtensionInstallation" (
    "id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionInstallation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExtensionPairingGrant" (
    "id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "installationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionPairingGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExtensionPairingGrant_installationId_key"
  ON "ExtensionPairingGrant"("installationId");

CREATE INDEX "ExtensionPairingGrant_origin_expiresAt_idx"
  ON "ExtensionPairingGrant"("origin", "expiresAt");

CREATE INDEX "ExtensionInstallation_origin_revokedAt_expiresAt_idx"
  ON "ExtensionInstallation"("origin", "revokedAt", "expiresAt");

ALTER TABLE "ExtensionPairingGrant"
  ADD CONSTRAINT "ExtensionPairingGrant_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "ExtensionInstallation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
