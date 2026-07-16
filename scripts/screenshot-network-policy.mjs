const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const WEB_SOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);

export async function installScreenshotNetworkPolicy(context) {
  const attemptedUrls = [];

  await context.route(
    (url) => HTTP_PROTOCOLS.has(url.protocol),
    async (route) => {
      attemptedUrls.push(route.request().url());
      await route.abort("blockedbyclient");
    }
  );

  await context.routeWebSocket(
    (url) => WEB_SOCKET_PROTOCOLS.has(url.protocol),
    async (webSocketRoute) => {
      attemptedUrls.push(webSocketRoute.url());
      await webSocketRoute.close({
        code: 1008,
        reason: "Setup screenshots forbid network access",
      });
    }
  );

  return {
    getAttemptedUrls() {
      return [...attemptedUrls];
    },
    assertNoNetworkAttempts() {
      if (attemptedUrls.length === 0) return;

      throw new Error(
        "Setup screenshots must use static HTML and synthetic fixtures only.\n" +
          "Blocked network attempts:\n" +
          attemptedUrls.map((url) => `- ${url}`).join("\n")
      );
    },
  };
}
