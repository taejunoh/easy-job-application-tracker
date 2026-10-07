import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const script = pathToFileURL(join(__dirname, "../../scripts/verify-local-onboarding.mjs")).href;
const describeSignal = process.env.RUN_LOCAL_ONBOARDING_SIGNAL_INTEGRATION === "1" ? describe : describe.skip;

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
