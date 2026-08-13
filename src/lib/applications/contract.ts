import "server-only";

import {
  InvalidRequestError,
  RequestBodyTooLargeError,
  readBoundedJsonBody,
} from "@/lib/security/request-body";

export const APPLICATION_BODY_LIMIT_BYTES = 256 * 1024;

const STATUSES = Object.freeze(["Applied", "Interview", "Offer", "Rejected"] as const);
const JOB_TYPES = Object.freeze(["Remote", "Hybrid", "Onsite"] as const);
const SORT_FIELDS = Object.freeze([
  "appliedDate",
  "createdAt",
  "updatedAt",
  "jobTitle",
  "company",
] as const);
const SORT_ORDERS = Object.freeze(["asc", "desc"] as const);

const CREATE_KEYS = new Set([
  "url",
  "jobTitle",
  "company",
  "status",
  "appliedDate",
  "description",
  "notes",
  "salary",
  "location",
  "jobType",
]);
const UPDATE_KEYS = new Set([
  "jobTitle",
  "company",
  "status",
  "description",
  "notes",
  "salary",
  "location",
  "jobType",
]);
const LIST_KEYS = new Set(["status", "jobType", "search", "sortBy", "sortOrder"]);

type Status = (typeof STATUSES)[number];
type JobType = (typeof JOB_TYPES)[number];
type SortField = (typeof SORT_FIELDS)[number];
type SortOrder = (typeof SORT_ORDERS)[number];

export type CreateApplicationInput = Readonly<{
  url: string;
  jobTitle: string;
  company: string;
  status: Status;
  appliedDate: Date | undefined;
  description: string | null;
  notes: string | null;
  salary: string | null;
  location: string | null;
  jobType: JobType | null;
}>;

export type UpdateApplicationData = Readonly<{
  jobTitle?: string;
  company?: string;
  status?: Status;
  description?: string | null;
  notes?: string | null;
  salary?: string | null;
  location?: string | null;
  jobType?: JobType | null;
}>;

export type UpdateApplicationInput = Readonly<{
  id: string;
  data: UpdateApplicationData;
}>;

export type ListApplicationsInput = Readonly<{
  status: Status | undefined;
  jobType: JobType | undefined;
  search: string | undefined;
  sortBy: SortField;
  sortOrder: SortOrder;
}>;

export class ApplicationContractError extends Error {
  readonly status: 400 | 413;
  readonly code: "invalid_request" | "request_too_large";

  constructor(status: 400 | 413, code: "invalid_request" | "request_too_large") {
    super(code === "request_too_large" ? "Request too large" : "Invalid request");
    this.name = "ApplicationContractError";
    this.status = status;
    this.code = code;
  }
}

export async function parseCreateApplicationRequest(
  request: Request,
): Promise<CreateApplicationInput> {
  const body = expectObject(await readApplicationBody(request));
  expectAllowedKeys(body, CREATE_KEYS);

  return immutable({
    url: parseUrl(body.url),
    jobTitle: requiredText(body.jobTitle, 256),
    company: requiredText(body.company, 256),
    status: body.status === undefined ? "Applied" : enumValue(body.status, STATUSES),
    appliedDate: body.appliedDate === undefined ? undefined : rfc3339Date(body.appliedDate),
    description: nullableText(body.description, 100_000),
    notes: nullableText(body.notes, 20_000),
    salary: nullableText(body.salary, 512),
    location: nullableText(body.location, 512),
    jobType: nullableEnum(body.jobType, JOB_TYPES),
  });
}

export async function parseUpdateApplicationRequest(
  id: string,
  request: Request,
): Promise<UpdateApplicationInput> {
  if (!isUuid(id)) invalid();
  const body = expectObject(await readApplicationBody(request));
  expectAllowedKeys(body, UPDATE_KEYS);
  const keys = Object.keys(body);
  if (keys.length === 0) invalid();

  const data = Object.create(null) as Record<string, unknown>;
  if ("jobTitle" in body) data.jobTitle = requiredText(body.jobTitle, 256);
  if ("company" in body) data.company = requiredText(body.company, 256);
  if ("status" in body) data.status = enumValue(body.status, STATUSES);
  if ("description" in body) data.description = nullableText(body.description, 100_000);
  if ("notes" in body) data.notes = nullableText(body.notes, 20_000);
  if ("salary" in body) data.salary = nullableText(body.salary, 512);
  if ("location" in body) data.location = nullableText(body.location, 512);
  if ("jobType" in body) data.jobType = nullableEnum(body.jobType, JOB_TYPES);

  return immutable({ id, data: Object.freeze(data) as UpdateApplicationData });
}

export function parseListApplicationsRequest(url: URL): ListApplicationsInput {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!LIST_KEYS.has(key) || seen.has(key)) invalid();
    seen.add(key);
  }

  const status = optionalQueryEnum(url.searchParams.get("status"), STATUSES);
  const jobType = optionalQueryEnum(url.searchParams.get("jobType"), JOB_TYPES);
  const searchRaw = url.searchParams.get("search");
  const search = searchRaw === null ? undefined : requiredText(searchRaw, 256);
  const sortByRaw = url.searchParams.get("sortBy");
  const sortOrderRaw = url.searchParams.get("sortOrder");

  return immutable({
    status,
    jobType,
    search,
    sortBy: sortByRaw === null ? "appliedDate" : enumValue(sortByRaw, SORT_FIELDS),
    sortOrder: sortOrderRaw === null ? "desc" : enumValue(sortOrderRaw, SORT_ORDERS),
  });
}

export function applicationContractErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof ApplicationContractError)) return undefined;
  return Response.json(
    {
      error: error.code === "request_too_large" ? "Request too large" : "Invalid request",
      code: error.code,
    },
    { status: error.status },
  );
}

async function readApplicationBody(request: Request): Promise<unknown> {
  try {
    return await readBoundedJsonBody(request, APPLICATION_BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new ApplicationContractError(413, "request_too_large");
    }
    if (error instanceof InvalidRequestError || error instanceof SyntaxError || error instanceof TypeError) {
      invalid();
    }
    throw error;
  }
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function expectAllowedKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) invalid();
  }
}

function requiredText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || codePointLength(normalized) > maxCodePoints) invalid();
  return normalized;
}

function nullableText(value: unknown, maxCodePoints: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (codePointLength(normalized) > maxCodePoints) invalid();
  return normalized.length === 0 ? null : normalized;
}

function parseUrl(value: unknown): string {
  const normalized = requiredText(value, 2048);
  if (/\p{Cc}/u.test(normalized)) invalid();

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    invalid();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    invalid();
  }
  return normalized;
}

function rfc3339Date(value: unknown): Date {
  if (typeof value !== "string") invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) invalid();

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    !validOffset(zone)
  ) {
    invalid();
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || new Date(parsed.toISOString()).getTime() !== parsed.getTime()) {
    invalid();
  }
  return parsed;
}

function validOffset(zone: string): boolean {
  if (zone === "Z") return true;
  const hour = Number(zone.slice(1, 3));
  const minute = Number(zone.slice(4, 6));
  return hour <= 23 && minute <= 59;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nullableEnum<T extends string>(value: unknown, values: readonly T[]): T | null {
  if (value === undefined || value === null || value === "") return null;
  return enumValue(value, values);
}

function optionalQueryEnum<T extends string>(value: string | null, values: readonly T[]): T | undefined {
  return value === null ? undefined : enumValue(value, values);
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function invalid(): never {
  throw new ApplicationContractError(400, "invalid_request");
}
