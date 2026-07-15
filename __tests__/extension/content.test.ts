import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const contentScript = readFileSync(
  join(process.cwd(), "extension/content.js"),
  "utf8"
);

function extractLeverCompany(ogSiteName: string, logoAlt: string): string {
  const addListener = jest.fn();
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener },
      },
    },
    document: {
      querySelector: jest.fn((selector: string) => {
        if (selector === ".posting-headline h2") {
          return { textContent: "Software Engineer" };
        }
        if (selector === ".main-header-logo img") {
          return { alt: logoAlt };
        }
        if (selector === 'meta[property="og:site_name"]') {
          return { getAttribute: () => ogSiteName };
        }
        return null;
      }),
      querySelectorAll: jest.fn(() => []),
    },
    window: {
      location: {
        hostname: "jobs.lever.co",
        href: "https://jobs.lever.co/example/job-id",
      },
    },
  });

  new vm.Script(contentScript).runInContext(context);

  const listener = addListener.mock.calls[0][0];
  let response: { company: string } | undefined;
  listener({ action: "extractJob" }, {}, (data: { company: string }) => {
    response = data;
  });

  return response!.company;
}

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

  it.each([
    ["Olo logo", "Ignored logo", "Olo"],
    ["Acme LOGO", "", "Acme"],
    ["Logo Design Inc.", "", "Logo Design Inc."],
    ["Logo", "", "Logo"],
    ["", "Olo logo", "Olo"],
  ])(
    "normalizes the Lever company label %p without over-matching",
    (ogSiteName, logoAlt, expected) => {
      expect(extractLeverCompany(ogSiteName, logoAlt)).toBe(expected);
    }
  );
});
