import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const backgroundPath = join(process.cwd(), "extension/background.js");

describe("extension trusted storage background", () => {
  it("locks local storage to trusted extension contexts at startup", async () => {
    expect(existsSync(backgroundPath)).toBe(true);
    if (!existsSync(backgroundPath)) return;

    const setAccessLevel = jest.fn().mockResolvedValue(undefined);
    const script = readFileSync(backgroundPath, "utf8");
    const context = vm.createContext({
      chrome: { storage: { local: { setAccessLevel } } },
    });

    new vm.Script(script).runInContext(context);
    await Promise.resolve();

    expect(setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("handles storage access-level rejection without an unhandled failure", async () => {
    expect(existsSync(backgroundPath)).toBe(true);
    if (!existsSync(backgroundPath)) return;

    const setAccessLevel = jest.fn().mockRejectedValue(new Error("unsupported"));
    const remove = jest.fn().mockResolvedValue(undefined);
    const script = readFileSync(backgroundPath, "utf8");
    const context = vm.createContext({
      chrome: { storage: { local: { remove, setAccessLevel } } },
    });

    expect(() => new vm.Script(script).runInContext(context)).not.toThrow();
    for (let index = 0; index < 10 && !remove.mock.calls.length; index += 1) {
      await Promise.resolve();
    }

    expect(remove).toHaveBeenCalledWith([
      "connection",
      "serverUrl",
      "accessToken",
      "installationId",
      "installationToken",
    ]);
  });

  it("handles credential purge rejection after trusted storage setup fails", async () => {
    const setAccessLevel = jest.fn().mockRejectedValue(new Error("unsupported"));
    const remove = jest.fn().mockRejectedValue(new Error("purge unavailable"));
    const script = readFileSync(backgroundPath, "utf8");
    const context = vm.createContext({
      chrome: { storage: { local: { remove, setAccessLevel } } },
    });

    expect(() => new vm.Script(script).runInContext(context)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it.each(["missing", "throws"] as const)(
    "purges credentials when local.setAccessLevel synchronously %s",
    async (failure) => {
      const remove = jest.fn().mockResolvedValue(undefined);
      const local: Record<string, unknown> = { remove };
      if (failure === "throws") {
        local.setAccessLevel = jest.fn(() => {
          throw new Error("setAccessLevel unavailable");
        });
      }
      const script = readFileSync(backgroundPath, "utf8");
      const context = vm.createContext({ chrome: { storage: { local } } });

      expect(() => new vm.Script(script).runInContext(context)).not.toThrow();
      await Promise.resolve();

      expect(remove).toHaveBeenCalledWith([
        "connection",
        "serverUrl",
        "accessToken",
        "installationId",
        "installationToken",
      ]);
    }
  );
});
