import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const contentScript = readFileSync(
  join(process.cwd(), "extension/content.js"),
  "utf8"
);

describe("content script registration", () => {
  it("registers the message listener only once when executed twice", () => {
    const addListener = jest.fn();
    const windowMock: Record<string, unknown> = {};
    const context = vm.createContext({
      chrome: {
        runtime: {
          onMessage: { addListener },
        },
      },
      document: {
        querySelectorAll: jest.fn(() => []),
      },
      window: windowMock,
    });
    const script = new vm.Script(contentScript);

    script.runInContext(context);
    script.runInContext(context);

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(windowMock.__jobTrackerInjected).toBe(true);

    const listener = addListener.mock.calls[0][0];
    const sendResponse = jest.fn();
    expect(
      listener(
        { action: "autoFillProfiles", profiles: {} },
        {},
        sendResponse
      )
    ).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ filled: [] });
  });
});
