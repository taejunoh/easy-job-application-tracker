import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workflowUrl = pathToFileURL(
  join(__dirname, "../../scripts/screenshot-workflow.mjs"),
).href;

const runner = `
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import {
  APP_SCREENSHOT_CONTEXT_OPTIONS,
  waitForScreenshotReady,
} from ${JSON.stringify(workflowUrl)};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext(APP_SCREENSHOT_CONTEXT_OPTIONS);
  try {
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><body><nextjs-portal id="dev-tools">N</nextjs-portal>' +
        '<time id="date"></time><script>' +
        'window.framesObserved = 0;' +
        'requestAnimationFrame(() => {' +
          'window.framesObserved += 1;' +
          'requestAnimationFrame(() => { window.framesObserved += 1; });' +
        '});' +
        'document.getElementById("date").textContent = ' +
        'new Date("2026-04-08T00:00:00.000Z").toLocaleDateString();' +
        '</' + 'script></body></html>',
      { waitUntil: "domcontentloaded" },
    );
    await waitForScreenshotReady(page);
    const renderedDate = await page.locator("#date").textContent();
    const readiness = await page.evaluate(() => ({
      devToolsDisplay: getComputedStyle(
        document.getElementById("dev-tools"),
      ).display,
      fonts: document.fonts.status,
      framesObserved: window.framesObserved,
    }));
    const screenshot = await page.locator("body").screenshot({
      animations: "disabled",
    });
    process.stdout.write(JSON.stringify({
      renderedDate,
      screenshotHash: createHash("sha256").update(screenshot).digest("hex"),
      locale: APP_SCREENSHOT_CONTEXT_OPTIONS.locale,
      timezoneId: APP_SCREENSHOT_CONTEXT_OPTIONS.timezoneId,
      readiness,
    }));
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
`;

const warmPageRunner = `
import { createServer } from "node:http";
import { chromium } from "playwright";
import {
  APP_SCREENSHOT_CONTEXT_OPTIONS,
  openStableScreenshotPage,
} from ${JSON.stringify(workflowUrl)};

let requestCount = 0;
const server = createServer((_request, response) => {
  requestCount += 1;
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end('<!doctype html><body>' +
    (requestCount === 1 ? 'warming' : 'stable') + '</body>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext(APP_SCREENSHOT_CONTEXT_OPTIONS);
  try {
    const page = await context.newPage();
    await openStableScreenshotPage(page, 'http://127.0.0.1:' + address.port);
    process.stdout.write(JSON.stringify({
      body: await page.locator("body").textContent(),
      requestCount,
    }));
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
`;

function renderUnderHostTimezone(timezone: string) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", runner],
    {
      encoding: "utf8",
      env: { ...process.env, TZ: timezone },
    },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    renderedDate: string;
    screenshotHash: string;
    locale: string;
    timezoneId: string;
    readiness: {
      devToolsDisplay: string;
      fonts: string;
      framesObserved: number;
    };
  };
}

describe("app screenshot browser context", () => {
  test("renders identical dates and pixels under distinct host timezones", () => {
    const utc = renderUnderHostTimezone("UTC");
    const newYork = renderUnderHostTimezone("America/New_York");

    expect(utc.renderedDate).toBe(newYork.renderedDate);
    expect(utc.screenshotHash).toBe(newYork.screenshotHash);
    expect(utc).toMatchObject({
      renderedDate: "4/8/2026",
      screenshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      locale: "en-US",
      timezoneId: "UTC",
      readiness: {
        devToolsDisplay: "none",
        fonts: "loaded",
        framesObserved: expect.any(Number),
      },
    });
    expect(utc.readiness.framesObserved).toBeGreaterThanOrEqual(2);
    expect(newYork.readiness.framesObserved).toBeGreaterThanOrEqual(2);
  });

  test("captures after a preparation visit has warmed the page", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", warmPageRunner],
      { encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      body: "stable",
      requestCount: 2,
    });
  });
});
