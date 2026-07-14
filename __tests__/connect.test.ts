import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ConnectPage, {
  connectDestination,
  connectWithAccessToken,
} from "@/app/connect/page";
import {
  createClientApi,
  resetClientApiSessionRedirect,
} from "@/lib/client-api";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), refresh: jest.fn() }),
}));

describe("connectWithAccessToken", () => {
  beforeEach(() => {
    resetClientApiSessionRedirect();
  });

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

  it("re-arms session recovery after a successful session rotation", async () => {
    const navigate = jest.fn();
    const expiredFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    expiredFetch.mockResolvedValue(
      Response.json({ error: "Authentication required" }, { status: 401 }),
    );
    const api = createClientApi(navigate, {
      fetchImpl: expiredFetch,
      getLocation: () => ({ pathname: "/settings", search: "", hash: "" }),
    });

    await expect(api("/api/settings")).rejects.toMatchObject({ status: 401 });
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ authenticated: true }));
    await connectWithAccessToken("rotated-token");
    await expect(api("/api/settings")).rejects.toMatchObject({ status: 401 });

    expect(navigate).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
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
