import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(join(__dirname, "../../scripts/local-container-start.mjs")).href;
const valid = {
  NODE_ENV: "production", LOCAL_DOCKER_HTTP_ENABLED: "1",
  POSTGRES_PASSWORD: "c".repeat(64), DATABASE_URL: `postgresql://jobtracker:${"c".repeat(64)}@db:5432/jobtracker`,
  ENCRYPTION_SECRET: "e".repeat(64), APP_ACCESS_TOKEN: "a".repeat(64),
  APP_BASE_URL: "http://127.0.0.1:3000", CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
};

const describeSignals = process.platform === "win32" ? describe.skip : describe;
describeSignals("local container real-child shutdown", () => {
  it.each([
    ["app", "SIGTERM", false], ["app", "SIGINT", false],
    ["migration", "SIGTERM", false], ["migration", "SIGINT", false],
    ["app", "SIGTERM", true], ["migration", "SIGTERM", true],
  ] as const)("forwards %s %s and waits for exit (ignores signal: %s)", async (stage, signal, ignore) => {
    const childSource = `
      for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
        console.log("RECEIVED:" + signal);
        ${ignore ? "" : 'setTimeout(() => { console.log("DRAINED"); process.exit(0); }, 50);'}
      });
      console.log("READY:" + process.pid);
      setInterval(() => {}, 1000);
    `;
    const source = `
      import { spawn } from "node:child_process";
      import { startLocalContainer } from ${JSON.stringify(moduleUrl)};
      const status = await startLocalContainer({ env: ${JSON.stringify(valid)}, shutdownTimeoutMs: 150,
        run: (command, args, options) => {
          const migration = args.includes("migrate");
          console.log("STAGE:" + (migration ? "migration" : "app"));
          return spawn(process.execPath, ["-e", migration && ${JSON.stringify(stage)} === "app" ? "process.exit(0)" : ${JSON.stringify(childSource)}], { ...options, stdio: "inherit" });
        } });
      console.log("FINISHED:" + status);
      process.exitCode = status;
    `;
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let fixturePid: number | undefined;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => wrapper.once("exit", (code, signal) => resolve({ code, signal })));
    const deadline = setTimeout(() => wrapper.kill("SIGKILL"), 5000);
    try {
      await new Promise<void>((resolve, reject) => {
        wrapper.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const ready = /READY:(\d+)/u.exec(output);
          if (ready) { fixturePid = Number(ready[1]); resolve(); }
        });
        wrapper.once("exit", () => reject(new Error("Wrapper exited before fixture readiness: " + output)));
      });
      wrapper.kill(signal);
      const result = await exited;
      expect(output).toContain("RECEIVED:" + signal);
      if (!ignore) expect(output).toContain("DRAINED");
      expect(output).toContain("FINISHED:" + (signal === "SIGTERM" ? 143 : 130));
      expect(result).toEqual({ code: signal === "SIGTERM" ? 143 : 130, signal: null });
      if (stage === "migration") expect(output).not.toContain("STAGE:app");
      expect(() => process.kill(fixturePid!, 0)).toThrow();
    } finally {
      clearTimeout(deadline);
      wrapper.kill("SIGKILL");
      if (fixturePid) { try { process.kill(fixturePid, "SIGKILL"); } catch {} }
      await exited;
    }
  }, 8000);
});
