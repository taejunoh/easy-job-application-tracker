import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260813010000_application_identity/migration.sql"),
  "utf8",
);

describe("additive Application identity migration", () => {
  it("keeps legacy fields deployable while representing the self relation", () => {
    expect(schema).toMatch(/identityKey\s+String\?\s+@unique/u);
    expect(schema).toMatch(/canonicalUrl\s+String\?/u);
    expect(schema).toMatch(/duplicateOfId\s+String\?/u);
    expect(schema).toMatch(/identityState\s+String\s+@default\("legacy_unresolved"\)/u);
    expect(schema).toMatch(/onDelete:\s*Restrict/u);
    expect(schema).toMatch(/@@index\(\[duplicateOfId\]\)/u);
  });

  it("contains only additive identity DDL and no data rewrite", () => {
    expect(migration).not.toMatch(/^\s*(?:DROP|DELETE|TRUNCATE|UPDATE)\b/imu);
    expect(migration).toContain(
      'ADD COLUMN "identityState" TEXT NOT NULL DEFAULT \'legacy_unresolved\'',
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "Application_identityKey_key"');
    expect(migration).toContain('CREATE INDEX "Application_duplicateOfId_idx"');
    expect(migration).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
  });

  it("checks every state shape and forbids a self duplicate", () => {
    for (const state of ["canonical", "legacy_duplicate", "legacy_unresolved"]) {
      expect(migration).toContain(`'${state}'`);
    }
    expect(migration).toMatch(/"identityState"\s+IN\s*\(/u);
    expect(migration).toMatch(/"duplicateOfId"\s*<>\s*"id"/u);
    expect(migration).toMatch(
      /"identityState"\s*=\s*'canonical'[\s\S]*"identityKey"\s+IS NOT NULL[\s\S]*"canonicalUrl"\s+IS NOT NULL[\s\S]*"duplicateOfId"\s+IS NULL/u,
    );
    expect(migration).toMatch(
      /"identityState"\s*=\s*'legacy_unresolved'[\s\S]*"identityKey"\s+IS NULL[\s\S]*"canonicalUrl"\s+IS NULL[\s\S]*"duplicateOfId"\s+IS NULL/u,
    );
  });
});
