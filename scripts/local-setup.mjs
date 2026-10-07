import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addLocalExtension, ensureLocalConfig, isolatedDockerEnv, readLocalConfig } from "./local-setup-core.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function supportsNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return match && Number(match[1]) === 22 && (Number(match[2]) > 22 || (Number(match[2]) === 22 && Number(match[3]) >= 2));
}

function isLocalEndpoint(endpoint) {
  return typeof endpoint === "string" && (/^unix:\/\/\//u.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\//u.test(endpoint));
}

function dockerFailureDetails(result, secrets) {
  const output = [result.stdout, result.stderr].map(value => value == null ? "" : String(value)).filter(Boolean).join("\n")
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  let sanitized = output;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@");
  const tail = sanitized.trimEnd().slice(-4000);
  const status = result.status == null ? "unknown" : String(result.status);
  return `Docker command failed (exit code ${status}).${tail ? `\n${tail}` : ""}`;
}

export async function runLocalCommand({
  argv = process.argv.slice(2), repoRoot = defaultRepoRoot,
  configDir = join(repoRoot, ".jobtracker"), env = process.env,
  nodeVersion = process.versions.node, run = spawnSync,
  stdout = value => process.stdout.write(`${value}\n`), stderr = value => process.stderr.write(`${value}\n`),
} = {}) {
  try {
    if (!supportsNode(nodeVersion)) throw new Error("Use Node.js >=22.22.2 and <23, then retry this command.");
    const [command = "setup", ...options] = argv;
    if (!["setup", "start", "stop", "logs", "token", "extension"].includes(command)) throw new Error("Unknown local command.");
    let port;
    if (command === "setup" && options.length) {
      if (options.length !== 2 || options[0] !== "--port") throw new Error("Usage: npm run setup -- --port 3000");
      port = options[1];
    } else if (command === "extension") {
      if (options.length !== 1 || !/^[a-p]{32}$/u.test(options[0])) throw new Error("Usage: npm run local:extension -- <32-character a-p extension ID>");
    } else if (options.length) throw new Error("This local command does not accept additional arguments.");

    if (command === "token") {
      stdout(readLocalConfig({ configDir }).config.APP_ACCESS_TOKEN);
      return 0;
    }

    if (command === "setup" || command === "start") stdout("Checking local Docker...");

    const childEnv = isolatedDockerEnv(env);
    const childOptions = { cwd: resolve(repoRoot), env: childEnv, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 };
    let pinnedEndpoint;
    let managed;
    const docker = (args, message, extraOptions = {}) => {
      let result;
      const pinnedArgs = pinnedEndpoint ? ["--host", pinnedEndpoint, ...args] : args;
      try { result = run("docker", pinnedArgs, { ...childOptions, ...extraOptions }); } catch { throw new Error(message); }
      if (result.status !== 0 || result.error) {
        if (managed && result.status !== 0 && args.includes("--build")) {
          const secrets = [managed.config.APP_ACCESS_TOKEN, managed.config.ENCRYPTION_SECRET, managed.config.POSTGRES_PASSWORD, managed.config.DATABASE_URL];
          throw new Error(`${message}\n${dockerFailureDetails(result, secrets)}`);
        }
        throw new Error(message);
      }
      return result.stdout ?? "";
    };
    if (env.DOCKER_HOST && !isLocalEndpoint(env.DOCKER_HOST)) throw new Error("Use a local Docker daemon; remote Docker hosts are not supported for loopback-only setup.");
    const contextArgs = ["context", "inspect", ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), "--format", "{{json .Endpoints.docker.Host}}"];
    const context = docker(contextArgs, "Docker is unavailable. Install and start Docker with a local context, then retry.");
    let endpoint;
    try { endpoint = JSON.parse(context.trim()); } catch { throw new Error("Cannot verify the Docker context. Select a local Docker context, then retry."); }
    if (!env.DOCKER_CONTEXT && env.DOCKER_HOST) endpoint = env.DOCKER_HOST;
    if (!isLocalEndpoint(endpoint)) throw new Error("Select a local Docker context; remote contexts are not supported for loopback-only setup.");
    // Never resolve the mutable active context again after this locality check.
    pinnedEndpoint = endpoint;
    docker(["info", "--format", "{{.ServerVersion}}"], "The local Docker daemon is not running. Start Docker, then retry.");
    if (command === "setup") stdout("Creating or reusing private local configuration...");
    managed = command === "setup" ? ensureLocalConfig({ configDir, port }) : readLocalConfig({ configDir });
    const compose = (args, message, extraOptions) => docker([
      "compose", "--file", join(resolve(repoRoot), "compose.yaml"), "--env-file", managed.path,
      "--project-name", managed.config.JOBTRACKER_PROJECT_NAME, ...args,
    ], message, extraOptions);
    const help = compose(["up", "--help"], "Docker Compose is unavailable. Install Docker Compose with up --wait support, then retry.");
    if (!/(?:^|\s)--wait(?:\s|$)/u.test(help)) throw new Error("Update Docker Compose to a version supporting up --wait, then retry.");
    if (command === "setup" || command === "start") {
      stdout("Building and starting JobTracker (first run may take several minutes)...");
      compose(["up", "--build", "--wait", "--wait-timeout", "180"], "Local startup failed. Check Docker resources and the saved port, then retry. Use npm run local:logs for diagnostics; saved data and credentials were preserved.");
      stdout(managed.config.APP_BASE_URL); stdout("npm run local:token");
    } else if (command === "stop") {
      compose(["stop"], "Could not stop the local containers. Retry after checking Docker; no volumes were removed.");
    } else if (command === "logs") {
      compose(["logs", "--tail", "100"], "Could not read local container logs.", { stdio: "inherit" });
    } else if (command === "extension") {
      managed = addLocalExtension({ configDir, extensionId: options[0] });
      compose(["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "app"], "Extension origin was saved but app recreation failed. Retry the same extension command; credentials were preserved.");
    }
    return 0;
  } catch (error) {
    // Only errors constructed by this module or the managed-config validator reach users.
    stderr(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLocalCommand();
}
