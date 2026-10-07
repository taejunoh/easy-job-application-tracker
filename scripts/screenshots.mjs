import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installScreenshotNetworkPolicy } from "./screenshot-network-policy.mjs";
import { installSyntheticApiPolicy } from "./screenshot-api-policy.mjs";
import { loadAndValidateStartupEnv } from "./load-and-validate-startup-env.mjs";
import { readLocalConfig } from "./local-setup-core.mjs";
import {
  APP_SCREENSHOT_CONTEXT_OPTIONS,
  SETUP_SCREENSHOT_CONTEXT_OPTIONS,
  assertLocalCaptureBaseUrl,
  authenticateScreenshotContext,
  openStableScreenshotPage,
  runScreenshotWorkflow,
  waitForScreenshotReady,
} from "./screenshot-workflow.mjs";
import {
  popupFormFixture,
  keywordAnalysisFixture,
  popupConnectionFixture,
} from "./screenshot-fixtures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const POPUP_HTML_PATH = path.join(REPO_ROOT, "extension", "popup.html");
const CHROME_EXTENSIONS_SETUP_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "chrome-extensions-setup.html"
);
const SETUP_ONLY = process.argv.includes("--setup-only");
const LOCAL_MODE = process.argv.includes("--local");

async function assertDevServerUp(baseUrl) {
  let res;
  try {
    res = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
  } catch (cause) {
    throw new Error(
      "\n✗ Next.js dev server not reachable at " + baseUrl + "\n" +
        "  Run `npm run dev` in another terminal first.\n",
      { cause }
    );
  }
  if (res.status >= 500) {
    throw new Error(
      "\n✗ Next.js dev server at " + baseUrl + " returned " + res.status + "\n" +
      "  The server is up but failing. Check the dev server logs.\n"
    );
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (cause) {
    throw new Error(
      "\n✗ Chromium not installed for Playwright.\n" +
        "  Run `npx playwright install chromium` first.\n",
      { cause }
    );
  }
}

function stripPopupScript(html) {
  return html.replace(/<script[^>]*src="popup\.js"[^>]*>\s*<\/script>/g, "");
}

async function loadPopupPage(context) {
  const page = await context.newPage();

  try {
    await page.setViewportSize({ width: 400, height: 800 });
    const rawHtml = await readFile(POPUP_HTML_PATH, "utf8");
    const sanitized = stripPopupScript(rawHtml);
    await page.setContent(sanitized, { waitUntil: "domcontentloaded" });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function loadSettingsPage(context, baseUrl) {
  const page = await context.newPage();
  await page.goto(baseUrl + "/settings");
  // "API key configured" only renders after fetch resolves and
  // hasExistingKey is set to true — a reliable signal both that
  // the route mock fired and that the page is hydrated.
  await page.waitForSelector("text=API key configured");

  return page;
}

async function captureDashboard(context, baseUrl) {
  const page = await context.newPage();

  try {
    await openStableScreenshotPage(page, baseUrl + "/");
    await page.waitForSelector("h1:has-text('Dashboard')");
    await page.waitForSelector("text=Total Applied");

    await waitForScreenshotReady(page);
    await page.screenshot({
      path: path.join(OUT_DIR, "01-dashboard.png"),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await page.close();
  }
  console.log("✓ 01-dashboard.png");
}

async function captureSettingsResume(context, baseUrl) {
  const page = await loadSettingsPage(context, baseUrl);

  try {
    const resumeHeading = page.getByRole("heading", { name: "Resume", exact: true });
    const clip = await resumeHeading.evaluate((heading) => {
      const card = heading.closest(".settings-card");
      const cardBox = card.getBoundingClientRect();
      const h2Box = heading.getBoundingClientRect();
      const pad = 24;
      const topInPage = h2Box.top + window.scrollY - pad;
      const cardBottomInPage = cardBox.bottom + window.scrollY + pad;
      return {
        x: Math.max(0, cardBox.left - pad),
        y: Math.max(0, topInPage),
        width: cardBox.width + pad * 2,
        height: cardBottomInPage - topInPage,
      };
    });

    await page.screenshot({
      path: path.join(OUT_DIR, "02-settings-resume.png"),
      fullPage: true,
      clip,
    });
  } finally {
    await page.close();
  }
  console.log("✓ 02-settings-resume.png");
}

async function captureExtensionPopup(context) {
  const page = await loadPopupPage(context);

  try {
    await page.evaluate((fx) => {
      document.getElementById("form").style.display = "block";
      document.getElementById("extracting").style.display = "none";
      document.getElementById("noPage").style.display = "none";
      document.getElementById("jobTitle").value = fx.jobTitle;
      document.getElementById("company").value = fx.company;
      document.getElementById("location").value = fx.location;
      document.getElementById("analyzeBtn").style.display = "block";
      const serverUrl = document.getElementById("serverUrl");
      serverUrl.value = "http://localhost:3000";
      serverUrl.placeholder = "http://localhost:3000";
    }, popupFormFixture);

    await page.locator("body").screenshot({
      path: path.join(OUT_DIR, "03-extension-popup.png"),
    });
  } finally {
    await page.close();
  }
  console.log("✓ 03-extension-popup.png");
}

async function captureKeywordAnalysis(context) {
  const page = await loadPopupPage(context);

  try {
    await page.evaluate(
      ({ form, analysis }) => {
        document.getElementById("form").style.display = "block";
        document.getElementById("extracting").style.display = "none";
        document.getElementById("noPage").style.display = "none";
        document.getElementById("jobTitle").value = form.jobTitle;
        document.getElementById("company").value = form.company;
        document.getElementById("location").value = form.location;
        document.getElementById("analyzeBtn").style.display = "block";
        const serverUrl = document.getElementById("serverUrl");
        serverUrl.value = "http://localhost:3000";
        serverUrl.placeholder = "http://localhost:3000";

        const section = document.getElementById("analysisSection");
        section.style.display = "block";

        const badge = document.getElementById("analysisBadge");
        badge.textContent = analysis.percentage + "%";
        badge.classList.add(analysis.badgeClass);

        const fill = document.getElementById("progressFill");
        fill.style.width = analysis.percentage + "%";
        fill.classList.add(analysis.fillClass);

        const total = analysis.matched.length + analysis.missing.length;
        document.getElementById("analysisSummary").textContent =
          analysis.matched.length + " matched, " +
          analysis.missing.length + " missing out of " +
          total + " keywords";

        const matchedSection = document.getElementById("matchedSection");
        matchedSection.style.display = "block";
        document.getElementById("matchedPills").innerHTML =
          analysis.matched
            .map((k) => '<span class="pill pill-green">' + k + "</span>")
            .join("");

        const missingSection = document.getElementById("missingSection");
        missingSection.style.display = "block";
        document.getElementById("missingPills").innerHTML =
          analysis.missing
            .map((k) => '<span class="pill pill-red">' + k + "</span>")
            .join("");
      },
      { form: popupFormFixture, analysis: keywordAnalysisFixture }
    );

    await page.locator("body").screenshot({
      path: path.join(OUT_DIR, "04-keyword-analysis.png"),
    });
  } finally {
    await page.close();
  }
  console.log("✓ 04-keyword-analysis.png");
}

async function captureSettingsLlm(context, baseUrl) {
  const page = await loadSettingsPage(context, baseUrl);

  try {
    const llmHeading = page.getByRole("heading", { name: "LLM Provider", exact: true });
    const clip = await llmHeading.evaluate((heading) => {
      const card = heading.closest(".settings-card");
      const cardBox = card.getBoundingClientRect();
      const h2Box = heading.getBoundingClientRect();
      const profileH2 = [...card.querySelectorAll("h2")]
        .find((candidate) => candidate.textContent.trim() === "Profile URLs");
      const profileBox = profileH2.getBoundingClientRect();
      const pad = 24;
      return {
        x: Math.max(0, cardBox.left - pad),
        y: Math.max(0, h2Box.top + window.scrollY - pad),
        width: cardBox.width + pad * 2,
        height: (profileBox.top - h2Box.top) + pad,
      };
    });

    await page.screenshot({
      path: path.join(OUT_DIR, "05-settings-llm.png"),
      fullPage: true,
      clip,
    });
  } finally {
    await page.close();
  }
  console.log("✓ 05-settings-llm.png");
}

async function captureChromeLoadUnpacked(context) {
  const page = await context.newPage();

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    const setupHtml = await readFile(CHROME_EXTENSIONS_SETUP_PATH, "utf8");
    await page.setContent(setupHtml, { waitUntil: "domcontentloaded" });
    await page.screenshot({
      path: path.join(OUT_DIR, "06-chrome-load-unpacked.png"),
      fullPage: true,
      scale: "css",
    });
  } finally {
    await page.close();
  }
  console.log("✓ 06-chrome-load-unpacked.png");
}

async function preparePopupConnectionPage(context, connected) {
  const page = await loadPopupPage(context);

  try {
    await page.evaluate(
      ({ fixture, isConnected }) => {
        document.getElementById("extracting").style.display = "none";
        document.getElementById("form").style.display = "none";
        document.getElementById("noPage").style.display = "none";

        const serverUrl = document.getElementById("serverUrl");
        const accessToken = document.getElementById("accessToken");
        const connectBtn = document.getElementById("connectBtn");
        const disconnectBtn = document.getElementById("disconnectBtn");
        const connectionStatus = document.getElementById("connectionStatus");

        serverUrl.value = fixture.serverUrl;
        accessToken.value = isConnected ? "" : fixture.maskedToken;
        accessToken.style.caretColor = "transparent";
        connectBtn.textContent = "Connect";
        connectBtn.disabled = false;
        disconnectBtn.textContent = "Disconnect";
        disconnectBtn.disabled = !isConnected;
        connectionStatus.textContent = isConnected
          ? fixture.connectedStatus
          : fixture.disconnectedStatus;
        connectionStatus.className = isConnected
          ? "connection-status success"
          : "connection-status";
      },
      { fixture: popupConnectionFixture, isConnected: connected }
    );
    await page.evaluate(async () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      await document.fonts.ready;
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    });

    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function screenshotPopupBody(page, filename) {
  const dimensions = await page.evaluate(() => ({
    width: document.body.scrollWidth,
    height: document.body.scrollHeight,
  }));
  await page.setViewportSize(dimensions);
  await page.screenshot({
    path: path.join(OUT_DIR, filename),
    animations: "disabled",
    scale: "css",
  });
}

async function captureExtensionConnect(context) {
  const page = await preparePopupConnectionPage(context, false);

  try {
    await screenshotPopupBody(page, "07-extension-connect.png");
  } finally {
    await page.close();
  }
  console.log("✓ 07-extension-connect.png");
}

async function captureExtensionConnected(context) {
  const page = await preparePopupConnectionPage(context, true);

  try {
    await screenshotPopupBody(page, "08-extension-connected.png");
  } finally {
    await page.close();
  }
  console.log("✓ 08-extension-connected.png");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let baseUrl = "http://localhost:3000";
  let accessToken;

  if (SETUP_ONLY === false) {
    if (LOCAL_MODE) {
      const managed = readLocalConfig({ configDir: path.join(REPO_ROOT, ".jobtracker") });
      baseUrl = assertLocalCaptureBaseUrl(managed.config.APP_BASE_URL);
      accessToken = managed.config.APP_ACCESS_TOKEN;
    } else {
      loadAndValidateStartupEnv(true);
      baseUrl = assertLocalCaptureBaseUrl(process.env.APP_BASE_URL || baseUrl);
      accessToken = process.env.APP_ACCESS_TOKEN;
    }
    await assertDevServerUp(baseUrl);
  }

  const browser = await launchBrowser();
  await runScreenshotWorkflow({
    browser,
    setupOnly: SETUP_ONLY,
    appContextOptions: APP_SCREENSHOT_CONTEXT_OPTIONS,
    setupContextOptions: SETUP_SCREENSHOT_CONTEXT_OPTIONS,
    authenticateAppContext: (context) =>
      authenticateScreenshotContext(context, {
        baseUrl,
        accessToken,
      }),
    installAppApiPolicy: installSyntheticApiPolicy,
    captureAppScreenshots: async (context) => {
      await captureDashboard(context, baseUrl);
      await captureSettingsResume(context, baseUrl);
      await captureExtensionPopup(context);
      await captureKeywordAnalysis(context);
      await captureSettingsLlm(context, baseUrl);
    },
    installSetupNetworkPolicy: installScreenshotNetworkPolicy,
    captureSetupScreenshots: async (context) => {
      await captureChromeLoadUnpacked(context);
      await captureExtensionConnect(context);
      await captureExtensionConnected(context);
    },
  });

  console.log("\n✓ Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
