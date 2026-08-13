import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migrationPath = join(
  root,
  "prisma/migrations/20260813020000_extension_installations/migration.sql",
);

describe("additive extension installation migration", () => {
  it("models pairing grants and independently revocable installations", () => {
    expect(schema).toMatch(/model ExtensionPairingGrant \{/u);
    expect(schema).toMatch(/codeDigest\s+String/u);
    expect(schema).toMatch(/consumedAt\s+DateTime\?/u);
    expect(schema).toMatch(/model ExtensionInstallation \{/u);
    expect(schema).toMatch(/tokenDigest\s+String/u);
    expect(schema).toMatch(/lastUsedAt\s+DateTime\?/u);
    expect(schema).toMatch(/revokedAt\s+DateTime\?/u);
  });

  it("uses additive DDL with expiry, origin, and active-state indexes", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).not.toMatch(/^\s*(?:DROP|DELETE|TRUNCATE|UPDATE)\b/imu);
    expect(migration).toContain('CREATE TABLE "ExtensionPairingGrant"');
    expect(migration).toContain('CREATE TABLE "ExtensionInstallation"');
    expect(migration).toContain('"origin" TEXT NOT NULL');
    expect(migration).toContain('"expiresAt" TIMESTAMP(3) NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX "ExtensionPairingGrant_origin_expiresAt_idx"',
    );
    expect(migration).toContain(
      'CREATE INDEX "ExtensionInstallation_origin_revokedAt_expiresAt_idx"',
    );
  });

  it("never persists a plaintext pairing code or installation token", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(`${schema}\n${migration}`).not.toMatch(
      /\b(?:pairingCode|codeSecret|installationToken|tokenSecret)\b/u,
    );
  });
});
