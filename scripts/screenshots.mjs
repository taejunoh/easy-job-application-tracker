import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  statsFixture,
  settingsFixture,
  popupFormFixture,
  keywordAnalysisFixture,
} from "./screenshot-fixtures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const POPUP_HTML_PATH = path.join(REPO_ROOT, "extension", "popup.html");
const BASE_URL = "http://localhost:3000";

async function assertDevServerUp() {
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
    if (res.status >= 500) {
      throw new Error(`dev server returned ${res.status}`);
    }
  } catch (err) {
    console.error(
      "\n✗ Next.js dev server not reachable at " + BASE_URL + "\n" +
      "  Run `npm run dev` in another terminal first.\n"
    );
    process.exit(1);
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    console.error(
      "\n✗ Chromium not installed for Playwright.\n" +
      "  Run `npx playwright install chromium` first.\n"
    );
    process.exit(1);
  }
}

function stripPopupScript(html) {
  return html.replace(/<script[^>]*src="popup\.js"[^>]*>\s*<\/script>/g, "");
}

async function captureDashboard(context) {
  const page = await context.newPage();
  let statsHit = false;

  await page.route(/\/api\/stats/, async (route) => {
    statsHit = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(statsFixture),
    });
  });

  try {
    await page.goto(BASE_URL + "/");
    await page.waitForSelector("h1:has-text('Dashboard')");
    await page.waitForSelector("text=Total Applied");

    if (!statsHit) {
      throw new Error(
        "Dashboard did not request /api/stats — page structure may have changed."
      );
    }

    await page.screenshot({
      path: path.join(OUT_DIR, "01-dashboard.png"),
      fullPage: true,
    });
  } finally {
    await page.close();
  }
  console.log("✓ 01-dashboard.png");
}

async function main() {
  await assertDevServerUp();
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });

  try {
    await captureDashboard(context);
  } finally {
    await context.close();
    await browser.close();
  }

  console.log("\n✓ Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
