"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Next loads this adapter synchronously through CommonJS. */
const path = require("node:path");
const fs = require("node:fs");
const { globSync: tinyGlobSync } = require("tinyglobby");
const picomatch = require("picomatch");

// fdir otherwise traverses a directory symlink without emitting the alias itself.
// Use tinyglobby's public filesystem hook, not a separate walker or glob parser.
function readdirWithDirectoryLinks(directory, options, recordError) {
  let entries;
  try {
    entries = fs.readdirSync(directory, options);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) recordError(error);
    throw error;
  }
  return entries.map(entry => {
    if (!entry.isSymbolicLink()) return entry;
    let stat;
    try {
      stat = fs.statSync(path.join(directory, entry.name));
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return entry;
      recordError(error);
      throw error;
    }
    if (!stat.isDirectory()) return entry;
    return Object.assign(Object.create(entry), {
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });
  });
}

function globSync(pattern, options) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 4096) {
    throw new TypeError("Next rootDir must be a nonempty string of at most 4096 characters");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Next rootDir glob requires only { onlyDirectories: true }");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Next rootDir glob options must be a plain object");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.length !== 1 || keys[0] !== "onlyDirectories" ||
      Object.getOwnPropertyDescriptor(options, "onlyDirectories").value !== true) {
    throw new TypeError("Next rootDir glob requires only { onlyDirectories: true }");
  }

  // Bound and reject parser-sensitive syntax before asking picomatch to scan it.
  if (/[\x00-\x1f\x7f-\x9f{}[\]()?]/u.test(pattern) || pattern.includes("**") ||
      (process.platform !== "win32" && pattern.includes("\\"))) {
    throw new TypeError("Next rootDir supports literal paths and complete * path segments only");
  }
  const normalized = process.platform === "win32" ? pattern.replace(/\\/g, "/") : pattern;
  const scan = picomatch.scan(normalized, { parts: true, scanToEnd: true });
  const parts = scan.parts.length === 0 ? [normalized] : scan.parts;
  if (scan.isBrace || scan.isBracket || scan.isExtglob || scan.isGlobstar ||
      scan.negated || scan.negatedExtglob ||
      parts.some(part => part.includes("*") && part !== "*")) {
    throw new TypeError("Next rootDir supports literal paths and complete * path segments only");
  }
  const firstWildcard = parts.indexOf("*");
  if (firstWildcard !== -1 && parts.slice(firstWildcard + 1).some(part => part === "." || part === "..")) {
    throw new TypeError("Next rootDir does not support dot path segments after a wildcard");
  }

  let unexpectedFsError;
  const matches = tinyGlobSync(normalized, {
    expandDirectories: false,
    onlyDirectories: true,
    absolute: path.isAbsolute(normalized),
    fs: {
      readdirSync: (directory, options) => readdirWithDirectoryLinks(directory, options, error => {
        unexpectedFsError = error;
      }),
    },
  });
  // fdir suppresses readdir errors; preserve this hook's explicit error boundary.
  if (unexpectedFsError) throw unexpectedFsError;
  return matches;
}

module.exports = { globSync };
