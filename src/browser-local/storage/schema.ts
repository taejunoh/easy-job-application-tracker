import { isCivilDate } from "../../lib/application-calendar";

export const LOCAL_STATUSES = ["Applied", "Interview", "Offer", "Rejected"] as const;
export const LOCAL_JOB_TYPES = ["Remote", "Hybrid", "Onsite"] as const;

export type LocalStatus = (typeof LOCAL_STATUSES)[number];
export type LocalJobType = (typeof LOCAL_JOB_TYPES)[number];

export type LocalApplication = {
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  description: string | null;
  notes: string | null;
  salary: string | null;
  location: string | null;
  jobType: string | null;
  nextStep: string | null;
  nextStepDate: string | null;
  createdAt: string;
  updatedAt: string;
  identityKey: string | null;
  canonicalUrl: string | null;
  duplicateOfId: string | null;
  identityState: string;
};

export type LocalApplicationInput = Pick<LocalApplication, "url" | "jobTitle" | "company">
  & Partial<Pick<LocalApplication, "status" | "appliedDate" | "description" | "notes"
    | "salary" | "location" | "jobType" | "nextStep" | "nextStepDate">>;

export type LocalSettings = {
  linkedinUrl: string;
  githubUrl: string;
  resumeText: string;
};

export const EMPTY_SETTINGS: Readonly<LocalSettings> = Object.freeze({
  linkedinUrl: "",
  githubUrl: "",
  resumeText: "",
});

const APPLICATION_INPUT_KEYS = [
  "url", "jobTitle", "company", "status", "appliedDate", "description", "notes",
  "salary", "location", "jobType", "nextStep", "nextStepDate",
] as const;
const APPLICATION_KEYS = [
  ...APPLICATION_INPUT_KEYS, "id", "createdAt", "updatedAt", "identityKey",
  "canonicalUrl", "duplicateOfId", "identityState",
];
const SETTINGS_KEYS = ["linkedinUrl", "githubUrl", "resumeText"];

export function checkedObject(value: unknown, keys: readonly string[], label: string, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const object = value as Record<string, unknown>;
  const actualKeys = Object.keys(object);
  if ((!partial && actualKeys.length !== keys.length) || actualKeys.some((key) => !keys.includes(key))) {
    throw new Error(`Invalid fields in ${label}.`);
  }
  return object;
}

function checkedText(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string" || (value.length > max && [...value].length > max) || (required && !value.trim())) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function nullableText(value: unknown, max: number, label: string): string | null {
  return value === null ? null : checkedText(value, max, label);
}

function credentialParameter(name: string): boolean {
  return /^(?:api[_-]?key|auth(?:orization|entication)?|(?:access[_-]?|refresh[_-]?|id[_-]?|oauth[_-]?|session[_-]?|auth[_-]?|csrf[_-]?|x-amz-security-)?token|password|passwd|cookie|session(?:[_-]?id)?|client[_-]?secret|x-amz-credential|x-amz-signature|signature)$/i.test(name);
}

function checkedUrl(value: unknown, label: string, optional = false): string {
  const raw = checkedText(value, 2048, label, !optional);
  if (optional && raw === "") return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    /\p{Cc}/u.test(raw) ||
    url.username ||
    url.password ||
    [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(credentialParameter)
  ) {
    throw new Error(`Use an HTTP or HTTPS ${label} without credentials.`);
  }
  return raw;
}

export function checkedTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !isCivilDate(value.slice(0, 10))
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function checkedAppliedDate(value: unknown): string {
  if (isCivilDate(value)) return `${value}T00:00:00.000Z`;
  return checkedTimestamp(value, "application date");
}

export function checkedApplication(value: unknown): LocalApplication {
  const data = checkedObject(value, APPLICATION_KEYS, "application");
  if (data.nextStepDate !== null && !isCivilDate(data.nextStepDate)) {
    throw new Error("Invalid next step date.");
  }

  return {
    id: checkedText(data.id, 256, "application ID", true),
    url: checkedUrl(data.url, "job URL"),
    jobTitle: checkedText(data.jobTitle, 256, "job title", true),
    company: checkedText(data.company, 256, "company", true),
    status: checkedText(data.status, 64, "status", true),
    appliedDate: checkedAppliedDate(data.appliedDate),
    description: nullableText(data.description, 100_000, "description"),
    notes: nullableText(data.notes, 20_000, "notes"),
    salary: nullableText(data.salary, 512, "salary"),
    location: nullableText(data.location, 512, "location"),
    jobType: nullableText(data.jobType, 64, "job type"),
    nextStep: nullableText(data.nextStep, 120, "next step"),
    nextStepDate: data.nextStepDate,
    createdAt: checkedTimestamp(data.createdAt, "creation date"),
    updatedAt: checkedTimestamp(data.updatedAt, "update date"),
    identityKey: nullableText(data.identityKey, 256, "identity key"),
    canonicalUrl: data.canonicalUrl === null ? null : checkedUrl(data.canonicalUrl, "canonical URL"),
    duplicateOfId: nullableText(data.duplicateOfId, 256, "original application ID"),
    identityState: checkedText(data.identityState, 64, "identity state", true),
  };
}

export function checkedSettings(value: unknown): LocalSettings {
  const data = checkedObject(value, SETTINGS_KEYS, "settings");
  return {
    linkedinUrl: checkedUrl(data.linkedinUrl, "LinkedIn URL", true),
    githubUrl: checkedUrl(data.githubUrl, "GitHub URL", true),
    resumeText: checkedText(data.resumeText, 1_000_000, "resume text"),
  };
}

export function applicationWithInput(application: LocalApplication, input: unknown): LocalApplication {
  const fields = checkedObject(input, APPLICATION_INPUT_KEYS, "application changes", true);
  if (Object.hasOwn(fields, "status") && fields.status !== application.status &&
    !LOCAL_STATUSES.some((status) => status === fields.status)) {
    throw new Error("Invalid status.");
  }
  if (Object.hasOwn(fields, "jobType") && fields.jobType !== null && fields.jobType !== application.jobType &&
    !LOCAL_JOB_TYPES.some((jobType) => jobType === fields.jobType)) {
    throw new Error("Invalid job type.");
  }
  return checkedApplication({ ...application, ...fields });
}

export function normalizeJobUrl(value: string): string {
  const url = new URL(value);
  for (const name of [...url.searchParams.keys()]) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("utm_") || ["gclid", "fbclid", "trk", "ref", "source"].includes(normalized)) {
      url.searchParams.delete(name);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}
