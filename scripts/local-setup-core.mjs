import { randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import serverEnvCore from "../src/lib/server-env-core.js";

export const LOCAL_CONFIG_KEYS = Object.freeze([
  "JOBTRACKER_PROJECT_NAME", "JOBTRACKER_PORT", "POSTGRES_PASSWORD", "DATABASE_URL",
  "ENCRYPTION_SECRET", "APP_ACCESS_TOKEN", "APP_BASE_URL", "CORS_ALLOWED_ORIGINS",
  "LOCAL_DOCKER_HTTP_ENABLED", "APPLICATION_WRITES_ENABLED", "APPLICATION_IDENTITY_WRITES_ENABLED",
  "VALIDATION_MANUAL_ENTRY_ENABLED",
]);
const CONFIG_ERROR = "Invalid local configuration. Restore the original .jobtracker/local.env and its private permissions; do not regenerate secrets for an existing database.";

export function parsePort(value) {
  const text = String(value);
  if (!/^[1-9][0-9]{0,4}$/u.test(text) || Number(text) > 65535) {
    throw new Error("The local port must be an integer from 1 to 65535.");
  }
  return Number(text);
}

export function validateOwnedDatabase(env) {
  if (!/^[a-f0-9]{64}$/u.test(env.POSTGRES_PASSWORD ?? "") ||
      env.DATABASE_URL !== `postgresql://jobtracker:${env.POSTGRES_PASSWORD}@db:5432/jobtracker`) {
    throw new Error("Local migration requires the isolated Compose-owned database.");
  }
}

function validateConfig(config) {
  try {
    if (Object.keys(config).length !== LOCAL_CONFIG_KEYS.length ||
        LOCAL_CONFIG_KEYS.some(key => typeof config[key] !== "string") ||
        !/^jobtracker-[a-f0-9]{12}$/u.test(config.JOBTRACKER_PROJECT_NAME) ||
        config.APP_BASE_URL !== `http://127.0.0.1:${parsePort(config.JOBTRACKER_PORT)}` ||
        config.LOCAL_DOCKER_HTTP_ENABLED !== "1" || config.APPLICATION_WRITES_ENABLED !== "1" ||
        config.APPLICATION_IDENTITY_WRITES_ENABLED !== "0" || config.VALIDATION_MANUAL_ENTRY_ENABLED !== "0") {
      throw new Error();
    }
    const secrets = [config.POSTGRES_PASSWORD, config.ENCRYPTION_SECRET, config.APP_ACCESS_TOKEN];
    if (secrets.some(secret => !/^[a-f0-9]{64}$/u.test(secret)) || new Set(secrets).size !== 3) throw new Error();
    validateOwnedDatabase(config);
    serverEnvCore.validateServerEnv(config, "production");
    if (config.CORS_ALLOWED_ORIGINS.split(",").some(origin => origin !== origin.trim())) throw new Error();
  } catch {
    throw new Error(CONFIG_ERROR);
  }
  return Object.freeze(config);
}

function assertPrivate(path, directory) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
    throw new Error(CONFIG_ERROR);
  }
}

function prepareDirectory(configDir) {
  try { mkdirSync(configDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw new Error(CONFIG_ERROR); }
  assertPrivate(configDir, true);
}

function serialize(config) {
  return LOCAL_CONFIG_KEYS.map(key => `${key}=${config[key]}\n`).join("");
}

function writePrivateTemporary(configDir, contents) {
  const path = join(configDir, `.local-${randomBytes(12).toString("hex")}.tmp`);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, contents); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  return path;
}

export function readLocalConfig({ configDir }) {
  const directory = resolve(configDir);
  const path = join(directory, "local.env");
  try {
    assertPrivate(directory, true);
    assertPrivate(path, false);
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let contents;
    try { contents = readFileSync(descriptor, "utf8"); } finally { closeSync(descriptor); }
    const config = {};
    if (!contents.endsWith("\n")) throw new Error();
    for (const line of contents.slice(0, -1).split("\n")) {
      const match = /^([A-Z_]+)=([^\r\n]*)$/u.exec(line);
      if (!match || !LOCAL_CONFIG_KEYS.includes(match[1]) || Object.hasOwn(config, match[1])) throw new Error();
      config[match[1]] = match[2];
    }
    return { config: validateConfig(config), path };
  } catch {
    throw new Error(CONFIG_ERROR);
  }
}

export function ensureLocalConfig({ configDir, port }) {
  const directory = resolve(configDir);
  prepareDirectory(directory);
  const path = join(directory, "local.env");
  let exists = true;
  try { lstatSync(path); } catch (error) { if (error.code === "ENOENT") exists = false; else throw new Error(CONFIG_ERROR); }
  if (!exists) {
    const selectedPort = parsePort(port ?? 3000);
    const password = randomBytes(32).toString("hex");
    const origin = `http://127.0.0.1:${selectedPort}`;
    const config = validateConfig({
      JOBTRACKER_PROJECT_NAME: `jobtracker-${randomBytes(6).toString("hex")}`,
      JOBTRACKER_PORT: String(selectedPort), POSTGRES_PASSWORD: password,
      DATABASE_URL: `postgresql://jobtracker:${password}@db:5432/jobtracker`,
      ENCRYPTION_SECRET: randomBytes(32).toString("hex"), APP_ACCESS_TOKEN: randomBytes(32).toString("hex"),
      APP_BASE_URL: origin, CORS_ALLOWED_ORIGINS: origin, LOCAL_DOCKER_HTTP_ENABLED: "1",
      APPLICATION_WRITES_ENABLED: "1", APPLICATION_IDENTITY_WRITES_ENABLED: "0", VALIDATION_MANUAL_ENTRY_ENABLED: "0",
    });
    const temporary = writePrivateTemporary(directory, serialize(config));
    try {
      // An exclusive hard link publishes a complete file, including to concurrent setup processes.
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw new Error(CONFIG_ERROR);
    } finally { unlinkSync(temporary); }
  }
  const existing = readLocalConfig({ configDir: directory });
  if (port !== undefined && parsePort(port) !== Number(existing.config.JOBTRACKER_PORT)) {
    throw new Error("The requested port differs from the saved local port. Reuse the saved port; configuration was not changed.");
  }
  return existing;
}

export function addLocalExtension({ configDir, extensionId }) {
  if (!/^[a-p]{32}$/u.test(extensionId ?? "")) throw new Error("Provide an exact 32-character Chrome extension ID containing only a-p.");
  const existing = readLocalConfig({ configDir });
  const origin = `chrome-extension://${extensionId}`;
  const origins = existing.config.CORS_ALLOWED_ORIGINS.split(",");
  if (origins.includes(origin)) return existing;
  const config = validateConfig({ ...existing.config, CORS_ALLOWED_ORIGINS: [...origins, origin].join(",") });
  const temporary = writePrivateTemporary(resolve(configDir), serialize(config));
  try { assertPrivate(existing.path, false); renameSync(temporary, existing.path); }
  catch { try { unlinkSync(temporary); } catch {} throw new Error(CONFIG_ERROR); }
  return { config, path: existing.path };
}

export function isolatedDockerEnv(env) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => {
    const name = key.toUpperCase();
    return !name.startsWith("COMPOSE_") && !LOCAL_CONFIG_KEYS.includes(name) &&
      !["NODE_ENV", "POSTGRES_USER", "POSTGRES_DB", "DOCKER_HOST", "DOCKER_CONTEXT", "BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST"].includes(name);
  }));
  isolated.BUILDX_BUILDER = "default";
  return isolated;
}
