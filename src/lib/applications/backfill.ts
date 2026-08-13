import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  InvalidApplicationIdentityError,
  canonicalizeApplicationUrl,
} from "./identity.ts";

export type LegacyApplicationIdentityRow = Readonly<{
  id: string;
  url: string;
  createdAt: Date;
  [key: string]: unknown;
}>;

export type ApplicationIdentityAssignment = Readonly<{
  id: string;
  state: "canonical" | "legacy_duplicate" | "legacy_unresolved";
  identityKey: string | null;
  canonicalUrl: string | null;
  duplicateOfId: string | null;
}>;

export type PrivacySafeBackfillReport = Readonly<{
  schemaVersion: 1;
  mode: "dry-run" | "apply";
  rowCountBefore: number;
  rowCountAfter: number;
  stateTotals: Readonly<{
    canonical: number;
    legacy_duplicate: number;
    legacy_unresolved: number;
  }>;
  uniqueIndexVerified: boolean;
  rows: readonly Readonly<{
    rowIdHash: string;
    state: ApplicationIdentityAssignment["state"];
    duplicateOfIdHash?: string;
  }>[];
}>;

export function buildApplicationIdentityPlan(
  sourceRows: readonly LegacyApplicationIdentityRow[],
): readonly ApplicationIdentityAssignment[] {
  const rows = [...sourceRows].sort(compareRows);
  const validGroups = new Map<
    string,
    { canonicalUrl: string; rows: LegacyApplicationIdentityRow[] }
  >();
  const unresolved = new Set<string>();

  for (const row of rows) {
    try {
      const identity = canonicalizeApplicationUrl(row.url);
      const group = validGroups.get(identity.identityKey);
      if (group && group.canonicalUrl !== identity.canonicalUrl) {
        throw new Error("Application identity digest collision");
      }
      if (group) {
        group.rows.push(row);
      } else {
        validGroups.set(identity.identityKey, {
          canonicalUrl: identity.canonicalUrl,
          rows: [row],
        });
      }
    } catch (error) {
      if (!(error instanceof InvalidApplicationIdentityError)) throw error;
      unresolved.add(row.id);
    }
  }

  const assignments = new Map<string, ApplicationIdentityAssignment>();
  for (const [identityKey, group] of validGroups) {
    const winner = group.rows[0];
    assignments.set(
      winner.id,
      Object.freeze({
        id: winner.id,
        state: "canonical",
        identityKey,
        canonicalUrl: group.canonicalUrl,
        duplicateOfId: null,
      }),
    );
    for (const duplicate of group.rows.slice(1)) {
      assignments.set(
        duplicate.id,
        Object.freeze({
          id: duplicate.id,
          state: "legacy_duplicate",
          identityKey: null,
          canonicalUrl: group.canonicalUrl,
          duplicateOfId: winner.id,
        }),
      );
    }
  }
  for (const id of unresolved) {
    assignments.set(
      id,
      Object.freeze({
        id,
        state: "legacy_unresolved",
        identityKey: null,
        canonicalUrl: null,
        duplicateOfId: null,
      }),
    );
  }

  return Object.freeze(rows.map((row) => requiredAssignment(assignments, row.id)));
}

export function createPrivacySafeReport(input: Readonly<{
  mode: "dry-run" | "apply";
  rowCountBefore: number;
  rowCountAfter: number;
  uniqueIndexVerified: boolean;
  plan: readonly ApplicationIdentityAssignment[];
}>): PrivacySafeBackfillReport {
  const stateTotals = {
    canonical: 0,
    legacy_duplicate: 0,
    legacy_unresolved: 0,
  };
  for (const assignment of input.plan) stateTotals[assignment.state] += 1;

  return Object.freeze({
    schemaVersion: 1,
    mode: input.mode,
    rowCountBefore: input.rowCountBefore,
    rowCountAfter: input.rowCountAfter,
    stateTotals: Object.freeze(stateTotals),
    uniqueIndexVerified: input.uniqueIndexVerified,
    rows: Object.freeze(
      input.plan.map((assignment) =>
        Object.freeze({
          rowIdHash: opaqueRowId(assignment.id),
          state: assignment.state,
          ...(assignment.duplicateOfId
            ? { duplicateOfIdHash: opaqueRowId(assignment.duplicateOfId) }
            : {}),
        }),
      ),
    ),
  });
}

export async function writeBackfillReport(
  reportPath: string,
  report: PrivacySafeBackfillReport,
): Promise<void> {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function parseBackfillArguments(args: readonly string[]): Readonly<{
  apply: boolean;
  reportPath: string;
  writersStopped: boolean;
}> {
  let apply = false;
  let writersStopped = false;
  let reportPath: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error("Invalid arguments");
    seen.add(argument);
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--writers-stopped") {
      writersStopped = true;
    } else if (argument === "--report") {
      reportPath = args[index + 1];
      if (!reportPath || reportPath.startsWith("--")) throw new Error("Invalid arguments");
      index += 1;
    } else {
      throw new Error("Invalid arguments");
    }
  }

  if (!reportPath) throw new Error("Invalid arguments");
  if (apply && !writersStopped) {
    throw new Error("--apply requires --writers-stopped");
  }
  return Object.freeze({ apply, reportPath, writersStopped });
}

function compareRows(
  left: LegacyApplicationIdentityRow,
  right: LegacyApplicationIdentityRow,
): number {
  const dateOrder = left.createdAt.getTime() - right.createdAt.getTime();
  return dateOrder === 0
    ? Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
    : dateOrder;
}

function requiredAssignment(
  assignments: ReadonlyMap<string, ApplicationIdentityAssignment>,
  id: string,
): ApplicationIdentityAssignment {
  const assignment = assignments.get(id);
  if (!assignment) throw new Error("Backfill plan is incomplete");
  return assignment;
}

function opaqueRowId(id: string): string {
  return createHash("sha256")
    .update("application-identity-backfill-report-v1\0")
    .update(id)
    .digest("hex");
}
