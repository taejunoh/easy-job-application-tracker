const SHARED_SCREENSHOT_CONTEXT_OPTIONS = Object.freeze({
  viewport: Object.freeze({ width: 1280, height: 800 }),
  deviceScaleFactor: 2,
  serviceWorkers: "block",
});

export const APP_SCREENSHOT_CONTEXT_OPTIONS = Object.freeze({
  ...SHARED_SCREENSHOT_CONTEXT_OPTIONS,
  locale: "en-US",
  timezoneId: "UTC",
});

export const SETUP_SCREENSHOT_CONTEXT_OPTIONS =
  SHARED_SCREENSHOT_CONTEXT_OPTIONS;

export async function openStableScreenshotPage(page, url) {
  await page.goto(url);
  await page.reload();
}

export async function waitForScreenshotReady(page) {
  await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });
}

export async function authenticateScreenshotContext(
  context,
  { baseUrl, accessToken }
) {
  const sessionUrl = new URL("/api/auth/session", baseUrl).href;
  const response = await context.request.post(sessionUrl, {
    headers: { Origin: new URL(baseUrl).origin },
    data: { token: accessToken },
  });

  if (!response.ok()) {
    throw new Error(
      `Could not create the local screenshot session (HTTP ${response.status()}).`
    );
  }
}

export async function runScreenshotWorkflow({
  browser,
  setupOnly,
  appContextOptions,
  setupContextOptions,
  authenticateAppContext,
  captureAppScreenshots,
  installSetupNetworkPolicy,
  captureSetupScreenshots,
}) {
  let appContext;
  let setupContext;
  let workflowError;

  try {
    if (!setupOnly) {
      appContext = await browser.newContext(appContextOptions);
      await authenticateAppContext(appContext);
      await captureAppScreenshots(appContext);
    }

    setupContext = await browser.newContext(setupContextOptions);
    const setupNetworkPolicy = await installSetupNetworkPolicy(setupContext);
    let setupCaptureError;
    let setupPolicyError;
    try {
      await captureSetupScreenshots(setupContext);
    } catch (error) {
      setupCaptureError = error;
    }
    try {
      setupNetworkPolicy.assertNoNetworkAttempts();
    } catch (error) {
      setupPolicyError = error;
    }
    if (setupCaptureError && setupPolicyError) {
      throw new AggregateError(
        [setupCaptureError, setupPolicyError],
        "Setup screenshot capture violated the offline policy."
      );
    }
    if (setupCaptureError) throw setupCaptureError;
    if (setupPolicyError) throw setupPolicyError;
  } catch (error) {
    workflowError = error;
  }

  const closeResults = await Promise.allSettled(
    [setupContext, appContext]
      .filter((context) => context !== undefined)
      .map((context) => context.close())
  );
  const browserCloseResult = await Promise.resolve()
    .then(() => browser.close())
    .then(
      () => ({ status: "fulfilled" }),
      (reason) => ({ status: "rejected", reason })
    );
  const errors = [
    workflowError,
    ...closeResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason),
    browserCloseResult.status === "rejected"
      ? browserCloseResult.reason
      : undefined,
  ].filter((error) => error !== undefined);

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Screenshot workflow failed during cleanup.");
  }
}
