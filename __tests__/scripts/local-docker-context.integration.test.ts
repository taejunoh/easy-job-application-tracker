import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const describeDocker = process.env.RUN_LOCAL_DOCKER_CONTEXT_INTEGRATION === "1" ? describe : describe.skip;

describeDocker("local Docker build context", () => {
  it("excludes local credentials and ignored user artifacts while retaining required application inputs", () => {
    const temporary = mkdtempSync(join(tmpdir(), "jobtracker-docker-context-"));
    const context = join(temporary, "context");
    const output = join(temporary, "output");
    const sensitive = [
      ".env", ".env.local", "nested/.env.production", ".jobtracker/local.env", "nested/.jobtracker/local.env",
      "local.pem", "certificates/private.pem", "local.key", "certificates/private.key",
      ".git/config", ".worktrees/local/private.txt", ".artifacts/smoke/private.json",
      "node_modules/private.txt", ".next/cache/private.txt", ".vercel/project.json",
      "prisma/dev.db", "prisma/dev.db-journal", ".yarn/cache/private.txt", ".pnp.cjs", "tsconfig.tsbuildinfo",
    ];
    const required = ["package.json", "src/app/page.tsx", "public/icon.svg", "public/verification.pub"];
    const write = (path: string, contents: string) => {
      const absolute = join(context, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    };
    try {
      write(".dockerignore", readFileSync(join(__dirname, "../../.dockerignore"), "utf8"));
      write("Dockerfile", "FROM scratch\nCOPY . /\n");
      sensitive.forEach(path => write(path, "synthetic-local-private-material\n"));
      required.forEach(path => write(path, "required-application-build-input\n"));
      const result = spawnSync("docker", ["build", "--progress=plain", "--output", `type=local,dest=${output}`, context], {
        encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(`Docker context contract build failed: ${result.stderr.slice(-2000)}`);
      expect(sensitive.filter(path => existsSync(join(output, path)))).toEqual([]);
      for (const path of required) expect(readFileSync(join(output, path), "utf8")).toBe("required-application-build-input\n");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 70_000);
});
