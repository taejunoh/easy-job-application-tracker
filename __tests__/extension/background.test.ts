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
    const script = readFileSync(backgroundPath, "utf8");
    const context = vm.createContext({
      chrome: { storage: { local: { setAccessLevel } } },
    });

    expect(() => new vm.Script(script).runInContext(context)).not.toThrow();
    await Promise.resolve();
  });
});
