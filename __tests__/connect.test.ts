import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ConnectPage, {
  connectDestination,
  connectWithAccessToken,
} from "@/app/connect/page";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), refresh: jest.fn() }),
}));

describe("connectWithAccessToken", () => {
  it("posts the token only in same-origin JSON without client persistence", async () => {
    const response = Response.json({ authenticated: true });
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response);
    const token = "secret-access-token";

    const result = await connectWithAccessToken(token);

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(fetchMock.mock.calls[0][0]).not.toContain(token);
    fetchMock.mockRestore();
  });
});

describe("connectDestination", () => {
  it("returns a sanitized deep link from the query", () => {
    expect(
      connectDestination(
        "?next=%2Fapplications%2Fprobe.json%3Fview%3Dfull",
      ),
    ).toBe("/applications/probe.json?view=full");
  });

  it.each([
    "",
    "?next=https%3A%2F%2Fevil.example",
    "?next=%2F%2Fevil.example",
    "?next=%2Fconnect%3Fnext%3D%2Fsettings",
  ])("falls back to the dashboard for an unsafe query %s", (search) => {
    expect(connectDestination(search)).toBe("/");
  });
});

describe("ConnectPage accessibility", () => {
  it("uses one live-region role and AA-oriented muted text classes", () => {
    const markup = renderToStaticMarkup(createElement(ConnectPage));

    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup).not.toContain("aria-live=");
    expect(markup).not.toContain("text-gray-500");
    expect(markup).not.toContain("text-gray-600");
    expect(markup).not.toContain("placeholder:text-gray-600");
    expect(markup).toContain("placeholder:text-gray-400");
  });
});
