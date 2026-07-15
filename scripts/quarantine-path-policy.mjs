import {
  lstatSync,
  realpathSync,
} from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const GENERATED_ROOTS = Object.freeze(["node_modules", ".next"]);

const NUMBERED_COPY_SUFFIX = /^(.*) ([2-9][0-9]*)(\.[^/]+)$/u;
const ENTRY_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expectedKeys) {
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expectedKeys.includes(key)) {
      throw new TypeError(`unknown field: ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`missing field: ${key}`);
    }
  }
}

function assertRelativePath(value, label = "relative path") {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.length === 0 || isAbsolute(value) || value.includes("\0") || value.includes("\\")) {
    throw new TypeError(`${label} is unsafe`);
  }
  if (value !== value.normalize("NFC")) {
    throw new TypeError(`${label} must use NFC normalization`);
  }
  if (value.includes("//")) {
    throw new TypeError(`${label} contains a duplicate separator`);
  }
  const components = value.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new TypeError(`${label} contains an unsafe component`);
  }
  return value;
}

function assertEntryId(value) {
  if (typeof value !== "string" || value.length > 128 || !ENTRY_ID.test(value)) {
    throw new TypeError("entry ID is invalid");
  }
  return value;
}

export function canonicalPathForNumberedCopy(relativePath) {
  const safePath = assertRelativePath(relativePath);
  const slashIndex = safePath.lastIndexOf("/");
  const parent = slashIndex === -1 ? "" : safePath.slice(0, slashIndex + 1);
  const finalComponent = safePath.slice(slashIndex + 1);
  const match = NUMBERED_COPY_SUFFIX.exec(finalComponent);
  if (!match || match[1].length === 0) {
    throw new TypeError("path is not a numbered copy");
  }
  return `${parent}${match[1]}${match[3]}`;
}

export function parseManifestEntry(value) {
  assertPlainObject(value, "manifest entry");

  if (value.kind === "source-copy") {
    assertExactKeys(value, ["id", "kind", "relativePath", "canonicalRelativePath"]);
    const id = assertEntryId(value.id);
    const relativePath = assertRelativePath(value.relativePath);
    const canonicalRelativePath = assertRelativePath(value.canonicalRelativePath, "canonical path");
    const derivedCanonicalPath = canonicalPathForNumberedCopy(relativePath);
    if (canonicalRelativePath !== derivedCanonicalPath) {
      throw new TypeError("canonical path does not match the numbered-copy path");
    }
    return Object.freeze({ id, kind: "source-copy", relativePath, canonicalRelativePath });
  }

  if (value.kind === "generated-root") {
    assertExactKeys(value, ["id", "kind", "relativePath"]);
    const id = assertEntryId(value.id);
    const relativePath = assertRelativePath(value.relativePath);
    if (!GENERATED_ROOTS.includes(relativePath)) {
      throw new TypeError("generated root is not allowed");
    }
    return Object.freeze({ id, kind: "generated-root", relativePath });
  }

  throw new TypeError("manifest entry kind is invalid");
}

function isInside(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent !== "" && fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

export function assertPathUnderRoot(root, relativePath) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new TypeError("root must be absolute");
  }
  const safePath = assertRelativePath(relativePath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new TypeError("symlink root is forbidden");
  }
  if (!rootStat.isDirectory()) {
    throw new TypeError("root must be a directory");
  }

  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, ...safePath.split("/"));
  if (!isInside(canonicalRoot, candidate)) {
    throw new TypeError("path resolves outside root");
  }

  const components = safePath.split("/");
  let ancestor = canonicalRoot;
  for (const component of components.slice(0, -1)) {
    ancestor = join(ancestor, component);
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new TypeError("symlink ancestor is forbidden");
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}

export async function assertSameDevice(repoRoot, quarantineRoot, fsApi = { lstat, realpath }) {
  const [repoStat, quarantineStat] = await Promise.all([
    fsApi.lstat(repoRoot),
    fsApi.lstat(quarantineRoot),
  ]);
  if (repoStat.isSymbolicLink() || quarantineStat.isSymbolicLink()) {
    throw new TypeError("symlink root is forbidden");
  }

  const [resolvedRepo, resolvedQuarantine] = await Promise.all([
    fsApi.realpath(repoRoot),
    fsApi.realpath(quarantineRoot),
  ]);
  if (
    resolvedRepo === resolvedQuarantine ||
    isInside(resolvedRepo, resolvedQuarantine) ||
    isInside(resolvedQuarantine, resolvedRepo)
  ) {
    throw new TypeError("quarantine root must be outside the repository");
  }
  if (repoStat.dev !== quarantineStat.dev) {
    throw new Error("repository and quarantine root are on different devices");
  }
}

export function derivePayloadPath(runRoot, entry) {
  if (typeof runRoot !== "string" || !isAbsolute(runRoot)) {
    throw new TypeError("run root must be absolute");
  }
  const parsed = parseManifestEntry(entry);
  if (parsed.kind === "source-copy") {
    return join(runRoot, "payload", "source-copies", parsed.id);
  }
  return join(runRoot, "payload", "generated", parsed.relativePath);
}
