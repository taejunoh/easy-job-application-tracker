import {
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";

const REQUIRED_METHODS = Object.freeze([
  "lstat",
  "realpath",
  "mkdir",
  "open",
  "readdir",
  "rm",
  "rename",
  "unlink",
  "link",
  "opendir",
  "readlink",
  "createReadStream",
  "lstatSync",
  "realpathSync",
]);

const DEFAULT_SOURCE = Object.freeze({
  lstat,
  realpath,
  mkdir,
  open,
  readdir,
  rm,
  rename,
  unlink,
  link,
  opendir,
  readlink,
  createReadStream,
  lstatSync,
  realpathSync,
});

const contexts = new WeakMap();

function assertObject(value, label) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function normalizeSource(source) {
  assertPlainObject(source, "filesystem adapter");
  const adapter = Object.create(null);
  for (const methodName of REQUIRED_METHODS) {
    const implementation = source[methodName];
    if (typeof implementation !== "function") {
      throw new TypeError(`filesystem adapter must provide ${methodName}`);
    }
    adapter[methodName] = (...args) => Reflect.apply(implementation, source, args);
  }
  return Object.freeze(adapter);
}

export function bindRunFsContext(capability, source = DEFAULT_SOURCE) {
  assertObject(capability, "quarantine run capability");
  if (contexts.has(capability)) {
    throw new TypeError("quarantine run filesystem context is already bound");
  }
  const context = {
    source,
    adapter: normalizeSource(source),
    active: true,
  };
  contexts.set(capability, context);
  return context.adapter;
}

export function getRunFsContext(capability, source) {
  const sourceOmitted = arguments.length === 1;
  assertObject(capability, "quarantine run capability");
  const context = contexts.get(capability);
  if (context === undefined || !context.active) {
    throw new TypeError("quarantine run filesystem context is inactive");
  }
  if (!sourceOmitted && source !== context.source) {
    throw new TypeError("filesystem adapter must be the capability source object");
  }
  return context.adapter;
}

export function invalidateRunFsContext(capability) {
  const context = contexts.get(capability);
  if (context === undefined) return;
  context.active = false;
  contexts.delete(capability);
}
