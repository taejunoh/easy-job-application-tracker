import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const script = pathToFileURL(join(__dirname, "../../scripts/verify-local-onboarding.mjs")).href;
const describeSignal = process.env.RUN_LOCAL_ONBOARDING_SIGNAL_INTEGRATION === "1" ? describe : describe.skip;

// Exercise the actual acceptance runner while replacing only external resource boundaries.
// Removing response co-awaiting or route error forwarding must break these regressions.
async function isolatedFailure(scriptUrl: string, kind: string) {
  const importModule = new Function("name", "return import(name)");
  const { SourceTextModule, SyntheticModule, runInContext } = await importModule("node:vm") as typeof import("node:vm");
  const { EventEmitter } = await importModule("node:events");
  const { readFileSync } = await importModule("node:fs");
  const secret = "SYNTHETIC_PRIVATE_RESPONSE_COOKIE";
  const output: string[] = [], unhandled: string[] = [], commands: string[][] = [];
  const files = new Map<string, string>();
  let browserClosed = false, temporaryRemoved = false, aborted = false, afterExtractionRead = false, routeHandler: (route: unknown) => Promise<void>;
  let responseNumber = 0;
  const project = "jobtracker-123456abcdef";
  const config = { JOBTRACKER_PROJECT_NAME: project, JOBTRACKER_PORT: "43210", APP_BASE_URL: "http://127.0.0.1:43210", APP_ACCESS_TOKEN: secret };
  const failure = () => new Error(secret);
  const onUnhandled = (error: Error) => unhandled.push(error.message);
  process.on("unhandledRejection", onUnhandled);
  const locator = (name: string) => ({
    fill: async () => {}, waitFor: async () => {},
    inputValue: async () => { afterExtractionRead = true; return name === "Company" ? "Synthetic Acceptance Company" : "Synthetic Onboarding Engineer"; },
    click: async () => {
      if ((name === "Connect" && kind === "login-click") || (name === "Save Application" && kind === "save-click")) throw failure();
      if (name === "Connect" && kind === "login-response") await new Promise(resolve => setTimeout(resolve, 30));
      if (name === "+ Add") {
        // Playwright dispatches route callbacks independently of locator actions.
        void routeHandler({
          request: () => ({ method: () => kind === "route-method" ? "GET" : "POST", postDataJSON: () => {
            if (["route-json", "route-abort"].includes(kind)) throw failure();
            return runInContext(`JSON.parse(${JSON.stringify(JSON.stringify({ url: kind === "route-body" ? secret : "https://example.com/jobs/onboarding-synthetic" }))})`, context);
          } }),
          fulfill: async () => { if (kind === "route-fulfill") throw failure(); },
          abort: async () => { aborted = true; if (kind === "route-abort") throw failure(); },
        });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (name === "Save Application" && kind === "save-response") await new Promise(resolve => setTimeout(resolve, 30));
    },
  });
  const page = {
    setDefaultTimeout: () => {}, goto: async () => {}, getByLabel: locator,
    getByRole: (_role: string, options: { name: string }) => locator(options.name),
    waitForResponse: () => {
      responseNumber += 1;
      const prefix = responseNumber === 1 ? "login-" : "save-";
      return kind.startsWith(prefix)
        ? new Promise((_resolve, reject) => setTimeout(() => reject(failure()), 5))
        : Promise.resolve({ status: () => 200 });
    },
    route: async (_url: string, handler: typeof routeHandler) => { routeHandler = handler; },
  };
  const external: Record<string, unknown> = {
    "node:child_process": { spawn: (_command: string, args: string[]) => {
      commands.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 12345,
        stdin: { end: () => setImmediate(() => {
          let body = "";
          if (args.includes("context")) body = JSON.stringify("unix:///synthetic/docker.sock");
          else if (args.includes("rev-parse")) body = "synthetic-revision";
          else if (args.includes("inspect")) body = JSON.stringify(["app", "db"].map(service => ({
            Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": service } },
            State: { Running: true, Health: { Status: "healthy" } },
            NetworkSettings: { Ports: service === "app" ? { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43210" }] } : {} },
          })));
          else if (args.includes("compose") && args.includes("ps")) body = "app-id db-id";
          child.stdout.emit("data", Buffer.from(body));
          child.emit("close", 0);
        }) },
      });
      return child;
    } },
    "node:fs/promises": {
      mkdtemp: async () => "/synthetic/onboarding", mkdir: async () => {}, access: async () => { throw failure(); },
      writeFile: async (path: string, data: string) => { files.set(path, data); },
      readFile: async (path: string, encoding?: string) => encoding ? files.get(path) : Buffer.from("stable-config"),
      rm: async () => { temporaryRemoved = true; },
    },
    "node:net": { createServer: () => ({ once: () => {}, listen: (_port: number, _host: string, done: () => void) => done(), address: () => ({ port: 43210 }), close: (done: () => void) => done() }) },
    "./local-setup-core.mjs": { isolatedDockerEnv: () => ({}), validateOwnedDatabase: () => {}, readLocalConfig: () => ({ config, path: "/synthetic/onboarding/checkout/.jobtracker/local.env" }) },
    playwright: { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => { browserClosed = true; } }) },
      request: { newContext: async () => ({ post: async () => ({ status: () => 401 }), dispose: async () => {} }) } },
  };
  const cache = new Map();
  const load = async (name: string) => {
    if (cache.has(name)) return cache.get(name);
    const values = external[name] ?? await importModule(name);
    const dependency = new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
    cache.set(name, dependency);
    await dependency.link(() => { throw new Error("Synthetic dependency has no imports"); });
    await dependency.evaluate();
    return dependency;
  };
  const { createContext } = await importModule("node:vm");
  const context = createContext({ Buffer, URL, setTimeout, clearTimeout, process: {
    versions: process.versions, platform: process.platform, argv: [], env: {},
    on: process.on.bind(process), off: process.off.bind(process),
    stdout: { write: (value: string) => output.push(value) }, stderr: { write: (value: string) => output.push(value) },
  } });
  const runner = new SourceTextModule(readFileSync(new URL(scriptUrl), "utf8"), {
    context, initializeImportMeta: meta => { meta.url = scriptUrl; }, importModuleDynamically: load,
  });
  await runner.link(load);
  await runner.evaluate();
  const status = await (runner.namespace as { verifyLocalOnboarding: () => Promise<number> }).verifyLocalOnboarding();
  await new Promise(resolve => setTimeout(resolve, 40));
  process.off("unhandledRejection", onUnhandled);
  const diagnostics = [...files.entries()].find(([path]) => path.includes("/.artifacts/onboarding/"))?.[1];
  console.log(JSON.stringify({ status, unhandled, browserClosed, temporaryRemoved, aborted, afterExtractionRead,
    ownedCleanup: commands.some(args => args.includes("down") && args.includes("--volumes") && args.includes("--remove-orphans")),
    output: output.join(""), diagnostics }));
}

function verify(containers: unknown[], project = "jobtracker-123456abcdef", port = 43210) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { assertRuntimeIsolation } from ${JSON.stringify(script)};
    const input = JSON.parse(process.argv[1]);
    try { assertRuntimeIsolation(input.containers, input.project, input.port); console.log("accepted"); }
    catch { console.log("rejected"); }
  `, JSON.stringify({ containers, project, port })], { encoding: "utf8" });
}

type ContainerFixture = {
  Config: { Labels: Record<string, string> };
  State: { Running: boolean; Health: { Status: string } };
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
};

function containers(): ContainerFixture[] {
  return ["app", "db"].map<ContainerFixture>(service => ({
    Config: { Labels: { "com.docker.compose.project": "jobtracker-123456abcdef", "com.docker.compose.service": service } },
    State: { Running: true, Health: { Status: "healthy" } },
    NetworkSettings: { Ports: {
      "3000/tcp": service === "app" ? [{ HostIp: "127.0.0.1", HostPort: "43210" }] : null,
      "5432/tcp": null,
    } },
  }));
}

describe("Docker onboarding acceptance safety", () => {
  it.each(["login-click", "login-response", "save-click", "save-response", "route-method", "route-json", "route-body", "route-fulfill", "route-abort"])("contains %s failures in the main flow and cleans up without leaking diagnostics", kind => {
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-vm-modules", "--input-type=module", "-e",
      `await (${isolatedFailure.toString()})(${JSON.stringify(script)}, ${JSON.stringify(kind)});`], { encoding: "utf8", timeout: 10_000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stderr).toBe("");
    const actual = JSON.parse(result.stdout);
    expect(actual.unhandled).toEqual([]);
    expect(actual.status).toBe(1);
    expect(actual.browserClosed).toBe(true);
    expect(actual.temporaryRemoved).toBe(true);
    expect(actual.ownedCleanup).toBe(true);
    if (kind.startsWith("route-")) {
      expect(actual.aborted).toBe(true);
      expect(actual.afterExtractionRead).toBe(false);
    }
    expect(actual.output).not.toContain("SYNTHETIC_PRIVATE_RESPONSE_COOKIE");
    expect(actual.diagnostics).not.toContain("SYNTHETIC_PRIVATE_RESPONSE_COOKIE");
    expect(JSON.parse(actual.diagnostics)).toMatchObject({ cleanup: true, passed: false });
  });

  it.each([
    ["OCI runtime create failed: resource temporarily unavailable; Cookie: private", "container-runtime-failure"],
    ["invalid reference format postgresql://user:private@db/tracker", "invalid-image-reference"],
    ["arbitrary failure body APP_ACCESS_TOKEN=private", "command-failed"],
  ])("reports only a safe category for subprocess failures", (stderr, expected) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { commandFailureCategory } from ${JSON.stringify(script)};
      console.log(commandFailureCategory(process.argv[1]));
    `, stderr], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
    expect(result.stdout).not.toContain("private");
  });

  it("accepts only the healthy owned pair with loopback web and no database publication", () => {
    const result = verify(containers());
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("accepted");
  });

  it("refuses a default or production project identity", () => {
    const result = verify(containers(), "production");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("rejected");
  });

  it.each(["public-web", "wrong-port", "published-db", "foreign-project", "unhealthy", "duplicate-service", "extra-web-port"])("rejects unsafe runtime topology: %s", kind => {
    const pair = containers();
    if (kind === "public-web") pair[0].NetworkSettings.Ports["3000/tcp"]![0].HostIp = "0.0.0.0";
    if (kind === "wrong-port") pair[0].NetworkSettings.Ports["3000/tcp"]![0].HostPort = "3000";
    if (kind === "published-db") pair[1].NetworkSettings.Ports = { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] };
    if (kind === "foreign-project") pair[1].Config.Labels["com.docker.compose.project"] = "production";
    if (kind === "unhealthy") pair[1].State.Health.Status = "unhealthy";
    if (kind === "duplicate-service") pair[1].Config.Labels["com.docker.compose.service"] = "app";
    if (kind === "extra-web-port") pair[0].NetworkSettings.Ports["3000/tcp"]!.push({ HostIp: "::", HostPort: "43210" });
    const result = verify(pair);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("rejected");
  });
});

describeSignal("Docker onboarding interruption cleanup", () => {
  it("returns through finally instead of Playwright exiting before owned cleanup", async () => {
    const child = spawn(process.execPath, [join(__dirname, "../../scripts/verify-local-onboarding.mjs")], {
      cwd: join(__dirname, "../.."), stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", signalled = false;
    const timeout = setTimeout(() => child.kill("SIGINT"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!signalled && output.includes("run first-time npm setup")) {
        signalled = true;
        setTimeout(() => child.kill("SIGINT"), 750);
      }
    });
    child.stderr.resume(); // The harness prints only sanitized status; raw subprocess errors never reach this stream.
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timeout));
    expect(signalled).toBe(true);
    expect(status).toBe(1);
    const reportPath = /Redacted report: (.+)/u.exec(output)?.[1];
    expect(reportPath).toBeDefined();
    const report = JSON.parse(readFileSync(reportPath!, "utf8"));
    expect(report.interrupted).toBe(true);
    expect(report.cleanup).toBe(true);
    expect(report.passed).toBe(false);
  }, 120_000);
});
