import {
  extensionInstallationsFixture,
  settingsFixture,
  statsFixture,
} from "./screenshot-fixtures.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const EXPECTED_READS = new Map([
  ["GET /api/stats", statsFixture],
  ["GET /api/settings?includeResume=true", settingsFixture],
  ["GET /api/extension/installations", extensionInstallationsFixture],
]);

export async function installSyntheticApiPolicy(context) {
  const unexpectedRequests = [];

  await context.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = `${request.method()} ${url.pathname}${url.search}`;
      const fixture = EXPECTED_READS.get(key);

      if (!fixture) {
        unexpectedRequests.push(`${request.method()} request to an unexpected API route`);
        await route.abort("blockedbyclient");
        return;
      }

      await route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(fixture),
      });
    }
  );

  return {
    assertOnlySyntheticApiRequests() {
      if (unexpectedRequests.length === 0) return;

      throw new Error(
        "Screenshot app requests must use expected synthetic API fixtures only.\n" +
          "Blocked API requests:\n" +
          unexpectedRequests.map((request) => `- ${request}`).join("\n")
      );
    },
  };
}
