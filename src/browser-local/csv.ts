import { isCivilDate } from "../lib/application-calendar";
import { LOCAL_STATUSES, LOCAL_JOB_TYPES, makeApplication, normalizeJobUrl, type LocalApplicationInput } from "./storage/schema";

export const CSV_FIELDS = [
  ["company", "Company"], ["jobTitle", "Job title"], ["url", "Posting URL"],
  ["status", "Status"], ["appliedDate", "Date applied"], ["location", "Location"],
  ["jobType", "Job type"], ["salary", "Salary"], ["notes", "Notes"],
  ["description", "Job description"], ["nextStep", "Next step"], ["nextStepDate", "Next step date"],
] as const;

export const MAX_CSV_BYTES = 4 * 1024 * 1024;
type Field = typeof CSV_FIELDS[number][0];
export type CsvMapping = Partial<Record<Field, number>>;
export type CsvPreview = { entries: LocalApplicationInput[]; rejected: { row: number; reason: string }[] };

export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const input = source.replace(/^\uFEFF/, "");
  function finishField() {
    if (row.length >= 100) throw new Error("Use a CSV with at most 100 columns.");
    row.push(field);
    field = "";
    closed = false;
  }
  function finishRow() {
    finishField();
    if (row.some((value) => value.trim())) rows.push(row);
    if (rows.length > 5001) throw new Error("Use a CSV with at most 5,000 records.");
    row = [];
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (input[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (ch === ",") {
      finishField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      finishRow();
    } else if (closed || (ch === '"' && field)) {
      throw new Error("This CSV has an incorrectly quoted field.");
    } else if (ch === '"') {
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("This CSV has an unclosed quoted field.");
  finishRow();
  return rows;
}

function normalizedHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function suggestMapping(headers: string[]): CsvMapping {
  const aliases: Partial<Record<Field, string[]>> = {
    jobTitle: ["title", "position", "positiontitle", "role"],
    company: ["companyname", "employer"],
    appliedDate: ["applieddate", "applicationdate"],
    url: ["url", "link", "joburl", "postinglink"],
  };
  return Object.fromEntries(CSV_FIELDS.flatMap(([field, label]) => {
    const names = [normalizedHeader(label), normalizedHeader(field), ...(aliases[field] ?? [])];
    const index = headers.findIndex((header) => names.includes(normalizedHeader(header)));
    return index < 0 ? [] : [[field, index]];
  }));
}

type Identity = Pick<LocalApplicationInput, "url" | "company" | "jobTitle">;
export function csvDuplicates(existing: Identity[]) {
  const urls = new Set<string>();
  const names = new Set<string>();
  const namesWithoutUrl = new Set<string>();
  function identity(entry: Identity) {
    return {
      url: entry.url ? normalizeJobUrl(entry.url) : "",
      name: JSON.stringify([entry.company.trim().toLowerCase(), entry.jobTitle.trim().toLowerCase()]),
    };
  }
  function add(entry: Identity) {
    const { url, name } = identity(entry);
    names.add(name);
    if (url) urls.add(url);
    else namesWithoutUrl.add(name);
  }
  existing.forEach(add);
  return {
    add,
    has(entry: Identity) {
      const { url, name } = identity(entry);
      return url ? urls.has(url) || namesWithoutUrl.has(name) : names.has(name);
    },
  };
}

export function previewCsv(rows: string[][], mapping: CsvMapping, existing: Identity[]): CsvPreview {
  const entries: LocalApplicationInput[] = [];
  const rejected: CsvPreview["rejected"] = [];
  const seen = csvDuplicates(existing);
  rows.slice(1).forEach((row, index) => {
    const get = (field: Field) => row[mapping[field] ?? -1]?.trim() ?? "";
    const company = get("company");
    const jobTitle = get("jobTitle");
    const url = get("url");
    const date = get("appliedDate");
    const nextDate = get("nextStepDate");
    const rawStatus = get("status");
    const status = rawStatus ? LOCAL_STATUSES.find((value) => value.toLowerCase() === rawStatus.toLowerCase()) : date ? "Applied" : "Saved";
    const rawType = get("jobType");
    const jobType = LOCAL_JOB_TYPES.find((value) => value.toLowerCase() === rawType.toLowerCase());
    let reason = "";
    if (!company || !jobTitle) reason = "Company and job title are required.";
    else if (!status) reason = "Unknown status.";
    else if (rawType && !jobType) reason = "Unknown job type.";
    else if ((date && !isCivilDate(date)) || (nextDate && !isCivilDate(nextDate))) reason = "Use dates in YYYY-MM-DD format.";
    else if (status !== "Saved" && !date) reason = "An applied date is required for this status.";
    const entry: LocalApplicationInput = {
      company, jobTitle, url, status, appliedDate: status === "Saved" ? null : date,
      jobType: jobType ?? null, nextStepDate: nextDate || null,
      description: get("description") || null, notes: get("notes") || null,
      location: get("location") || null, salary: get("salary") || null,
      nextStep: get("nextStep") || null,
    };
    if (!reason) {
      try {
        const validated = makeApplication(entry);
        if (seen.has(validated)) reason = "Duplicate record.";
        else seen.add(validated);
      } catch (failure) {
        reason = failure instanceof Error ? failure.message : "Invalid application fields.";
      }
    }
    if (reason) rejected.push({ row: index + 2, reason });
    else entries.push(entry);
  });
  return { entries, rejected };
}

export function exportCsv(records: LocalApplicationInput[]): string {
  function cell(value: string) {
    const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }
  const headers = CSV_FIELDS.map(([, label]) => cell(label));
  const rows = records.map((record) => CSV_FIELDS.map(([field]) => {
    const value = field === "appliedDate" ? record.appliedDate?.slice(0, 10) : record[field];
    return cell(String(value ?? ""));
  }));
  return [headers, ...rows].map((row) => row.join(",")).join("\r\n") + "\r\n";
}
