-- Add nullable identity metadata so the legacy write path remains deployable.
ALTER TABLE "Application"
  ADD COLUMN "identityKey" TEXT,
  ADD COLUMN "canonicalUrl" TEXT,
  ADD COLUMN "duplicateOfId" TEXT,
  ADD COLUMN "identityState" TEXT NOT NULL DEFAULT 'legacy_unresolved';

ALTER TABLE "Application"
  ADD CONSTRAINT "Application_identity_state_check" CHECK (
    "identityState" IN ('canonical', 'legacy_duplicate', 'legacy_unresolved')
    AND (
      (
        "identityState" = 'canonical'
        AND "identityKey" IS NOT NULL
        AND "canonicalUrl" IS NOT NULL
        AND "duplicateOfId" IS NULL
      )
      OR (
        "identityState" = 'legacy_duplicate'
        AND "identityKey" IS NULL
        AND "duplicateOfId" IS NOT NULL
        AND "duplicateOfId" <> "id"
      )
      OR (
        "identityState" = 'legacy_unresolved'
        AND "identityKey" IS NULL
        AND "canonicalUrl" IS NULL
        AND "duplicateOfId" IS NULL
      )
    )
  );

CREATE UNIQUE INDEX "Application_identityKey_key"
  ON "Application"("identityKey");

CREATE INDEX "Application_duplicateOfId_idx"
  ON "Application"("duplicateOfId");

ALTER TABLE "Application"
  ADD CONSTRAINT "Application_duplicateOfId_fkey"
  FOREIGN KEY ("duplicateOfId") REFERENCES "Application"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
