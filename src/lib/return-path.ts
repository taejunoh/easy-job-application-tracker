const MAX_RETURN_PATH_LENGTH = 2_048;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const RETURN_PATH_BASE = "https://return-path.invalid";

export function sanitizeReturnPath(
  candidate: string | null | undefined,
): string | null {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_RETURN_PATH_LENGTH ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(candidate)
  ) {
    return null;
  }

  let parsed: URL;
  let decodedPathname: string;
  try {
    parsed = new URL(candidate, RETURN_PATH_BASE);
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (
    parsed.origin !== RETURN_PATH_BASE ||
    decodedPathname.startsWith("//") ||
    decodedPathname.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(decodedPathname) ||
    /^\/connect(?:\/|$)/u.test(decodedPathname)
  ) {
    return null;
  }

  return candidate;
}
