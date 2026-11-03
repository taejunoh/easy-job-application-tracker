/**
 * Pure display helpers for the free-text `location` field. Nothing here writes
 * to storage: callers use the results for display, filtering, and (for new
 * saves only) the value that is stored.
 */

const US_STATE_ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
});

/** State names that are also a country, so "City, Georgia" alone is not safely a US state. */
const NEEDS_US_CONTEXT = new Set(["georgia"]);

const US_COUNTRY_NAMES = new Set([
  "united states",
  "united states of america",
  "usa",
  "us",
  "u.s.",
  "u.s.a.",
]);

const NEW_YORK_CITY_NAMES = new Set(["new york", "new york city"]);

/** Whole values that name the New York City area with no state segment. */
const NEW_YORK_AREA_NAMES = new Set([
  "new york",
  "new york city",
  "new york metropolitan area",
  "new york city metropolitan area",
  "greater new york city area",
  "nyc",
]);

/** A job title captured as a location, for example "Remote Software Engineer (US)". */
const REMOTE_JOB_TITLE = /^remote\b.*\b(?:engineer|developer)\b/iu;
const LOCATION_COUNT_TEXT = /^available in \d+ locations\b/iu;
const TRAILING_NOT_APPLICABLE = /(?:^|, )n\/a$/iu;

/**
 * Cleans a location string for display:
 * - trims and collapses whitespace, removes space before commas, and puts one
 *   space after each comma;
 * - drops a trailing `N/A` segment left by job boards;
 * - rewrites `New York City, New York`, `New York, New York`, and the bare New
 *   York area names as `New York, NY`;
 * - rewrites `remote` in any case, and a job title captured as a remote location,
 *   as `Remote`;
 * - rewrites scraped `Available in 48 locations` text as `Multiple Locations`;
 * - rewrites `City, FullStateName` (optionally followed by a United States
 *   country segment) to the state abbreviation. "Georgia" is only rewritten when
 *   a United States segment follows, because it is also a country.
 *
 * Locations joined by semicolons are cleaned one by one. Anything else is
 * returned unchanged apart from the whitespace cleanup. A missing value yields
 * an empty string.
 */
export function normalizeLocation(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  if (!value.includes(";")) return normalizeSingleLocation(value);

  return value
    .split(";")
    .map(normalizeSingleLocation)
    .filter((location) => location !== "")
    .join("; ");
}

function normalizeSingleLocation(value: string): string {
  const text = value
    .replace(/\s+/gu, " ")
    .replace(/ ,/gu, ",")
    .replace(/,(?=\S)/gu, ", ")
    .trim()
    .replace(TRAILING_NOT_APPLICABLE, "");

  const lowered = text.toLowerCase();
  if (NEW_YORK_AREA_NAMES.has(lowered)) return "New York, NY";
  if (lowered === "remote" || REMOTE_JOB_TITLE.test(text)) return "Remote";
  if (LOCATION_COUNT_TEXT.test(text)) return "Multiple Locations";

  const parts = text.split(", ");
  if (parts.length < 2 || parts.length > 3) return text;

  const [city, stateName, ...rest] = parts;
  const usContext = rest.length === 1 && US_COUNTRY_NAMES.has(rest[0].toLowerCase());
  if (rest.length > 0 && !usContext) return text;
  if (city === "" || stateName === "") return text;

  const stateKey = stateName.toLowerCase();
  // "NY" is accepted as written so "New York City, NY" also unifies.
  const abbreviation =
    US_STATE_ABBREVIATIONS[stateKey] ?? (stateKey === "ny" ? "NY" : undefined);
  if (abbreviation === undefined) return text;
  if (NEEDS_US_CONTEXT.has(stateKey) && !usContext) return text;

  const normalizedCity =
    abbreviation === "NY" && NEW_YORK_CITY_NAMES.has(city.toLowerCase()) ? "New York" : city;
  return [normalizedCity, abbreviation, ...rest].join(", ");
}

/** True when the location text says the job is remote, for example "Remote - US". */
export function isRemoteLocation(location: string | null | undefined): boolean {
  return /\bremote\b/iu.test(normalizeLocation(location));
}

interface JobTypeSource {
  jobType: string | null;
  location: string | null;
}

/** The stored job type, or "Remote" when it is empty and the location says remote. */
export function displayJobType(application: JobTypeSource): string | null {
  if (application.jobType) return application.jobType;
  return isRemoteLocation(application.location) ? "Remote" : null;
}
