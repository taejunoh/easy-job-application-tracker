# Isolated validation preflight

This is the human-only continuation checklist for the local, read-only Task 1
preflight. Run it before any later external write. A pass is a prerequisite
for later work; it is not permission to write to a database, deploy a provider
resource, or access Preview.

## Before running the preflight

1. Run this from the repository checkout root. The script requires the
   canonicalized current working directory to be the real repository root; a
   parent or another directory is refused.
2. Prepare a private isolated-validation manifest containing the exact IDs
   returned for the isolated environment. Prepare a separate deny list from
   read-only confirmed Production IDs. The preflight compares the supplied
   values; it does not verify either list with a provider.
3. Keep both JSON inputs outside the repository as regular, non-symlink files,
   at most 16 KiB, with mode `0600`. They contain identifiers and a database
   host only—never credentials, passwords, tokens, connection strings, or
   other secrets.
4. Choose a new report path outside the repository. The report is created with
   mode `0600` and is never overwritten; an existing report path is a refusal.

The manifest has exactly these top-level fields:

```json
{
  "schemaVersion": 1,
  "kind": "jobtracker-isolated-validation-manifest",
  "environmentId": "<ISOLATED_ENVIRONMENT_UUID>",
  "sourceSha": "<APPROVED_40_HEX_SHA>",
  "vercelProjectId": "<ISOLATED_VERCEL_PROJECT_ID>",
  "neonOrganizationId": "<ISOLATED_NEON_ORGANIZATION_ID>",
  "database": {
    "projectId": "<ISOLATED_NEON_PROJECT_ID>",
    "branchId": "<ISOLATED_NEON_BRANCH_ID>",
    "endpointId": "<ISOLATED_NEON_ENDPOINT_ID>",
    "host": "<ISOLATED_DATABASE_HOST>",
    "port": 5432,
    "database": "<ISOLATED_DATABASE_NAME>"
  }
}
```

The deny list has exactly these fields. Each array must be non-empty and must
contain unique values:

```json
{
  "schemaVersion": 1,
  "kind": "jobtracker-production-deny-list",
  "vercelProjectIds": ["<CONFIRMED_PRODUCTION_VERCEL_PROJECT_ID>"],
  "neonOrganizationIds": ["<CONFIRMED_PRODUCTION_NEON_ORGANIZATION_ID>"],
  "neonProjectIds": ["<CONFIRMED_PRODUCTION_NEON_PROJECT_ID>"],
  "databaseHosts": ["<CONFIRMED_PRODUCTION_DATABASE_HOST>"]
}
```

Replace every placeholder with the reviewed value before running. Do not edit
an isolated ID merely to make a refusal pass. A refusal is a stop condition.

## Run the local preflight

Set the approved source SHA to the reviewed commit and provide absolute paths
for the private files. The following is an opt-in command; the placeholder
values are intentionally not real resource IDs:

```bash
APPROVED_SHA='<APPROVED_40_HEX_SHA>'
npm run validate:isolated:preflight -- \
  --manifest /<private-path>/isolated-validation-manifest.json \
  --deny-list /<private-path>/production-deny-list.json \
  --report /<private-path>/isolated-validation-preflight-report.json \
  --source-sha "$APPROVED_SHA"
```

The command succeeds only when the supplied manifest source SHA matches the
argument, none of its Vercel/Neon IDs or database host appears in the supplied
Production deny list, the approved commit exists, and these reviewed paths
match the current checkout with no local changes:

- `prisma/schema.prisma`
- `prisma/migrations`
- `prisma.config.ts`
- `src/lib/applications/backfill.ts`
- `src/lib/applications/identity.ts`

On success, retain the newly created redacted report as local evidence. It
contains the source SHA, a digest of the exact manifest bytes, and the fixed
reviewed-path list; it does not contain the manifest's IDs or database host.

## What this proves—and what it does not

This preflight proves only local attestation against the supplied deny list and
reviewed-source parity. It does not prove cloud ownership, connect to Neon,
inspect a schema, verify database freshness or emptiness, run a migration,
verify provider deployment metadata, make an HTTP request, or authorize access
to a protected Preview. Record provider ownership evidence separately.

Do not describe this result as Phase A complete or as a deployment result. No
provider, database, credential, HTTP, Preview, Production, fixture, extension,
gate, backfill, or cleanup operation belongs in this stage.

## Required continuation boundaries

For a later database procedure, retrieve isolated credentials privately, connect
to the isolated endpoint, and verify freshness/emptiness and ownership before
writing. Then create the validation marker before the first **Application
schema/data mutation**. Creating the marker is itself a schema mutation, so
the marker must not be described as preceding every schema change; it precedes
the first Application schema/data mutation after the fresh-database checks.

For a later Preview procedure, retain Vercel Authentication and use an approved
browser-authenticated path for protected web/API evidence. An app access token
alone cannot pass Vercel Authentication. Never add a bypass secret, disable
protection, or treat a `401` or `403` as permission to proceed.

For future provider deployment metadata, treat all populated authoritative SHA
fields as one set: require at least one field, reject missing-all metadata, and
reject every conflict with the approved SHA. Do not fabricate a second channel
when only one exists.

Do not create fixtures, run identity backfill, toggle write gates, pair an
extension, or clean data in this stage. A later fixture plan must inspect the
actual `Application.id` SQL type first and choose timestamps deliberately to
test backfill winner ordering.

If any later external operation fails, preserve non-secret IDs and truthful
pending-cleanup evidence. Do not touch Production, upgrade a plan, reuse the
Production organization, or retry an uncertain creation response.
