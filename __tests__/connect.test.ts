/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

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

class TestResponse {
  readonly ok: boolean;
  constructor(readonly body: unknown, readonly status = 200) {
    this.ok = status >= 200 && status < 300;
  }
  async json() { return this.body; }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new TestResponse(body, status) as unknown as Response;
}

describe("connectWithAccessToken", () => {
beforeEach(() => {
  resetClientApiSessionRedirect();
  if (!globalThis.fetch) {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  }
});

  it("posts the token only in same-origin JSON without client persistence", async () => {
    const response = jsonResponse({ authenticated: true });
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
      jsonResponse({ error: "Authentication required" }, 401),
    );
    const api = createClientApi(navigate, {
      fetchImpl: expiredFetch,
      getLocation: () => ({ pathname: "/settings", search: "", hash: "" }),
    });

    await expect(api("/api/settings")).rejects.toMatchObject({ status: 401 });
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }));
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
  it("labels the secure token field, exposes a live status, and enables Connect after input", () => {
    render(createElement(ConnectPage));
    const input = screen.getByLabelText("Access token");
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", { name: "Connect" });

    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "secret-access-token" } });
    expect(button).toBeEnabled();
  });

  it("announces a failed connection as an alert without persisting the token", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "no" }, 401),
    );
    render(createElement(ConnectPage));
    const input = screen.getByLabelText("Access token");
    fireEvent.change(input, { target: { value: "secret-access-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That access token was not accepted.");
    expect(input).toHaveValue("secret-access-token");
    jest.restoreAllMocks();
  });
});
