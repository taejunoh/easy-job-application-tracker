import {
  ClientApiError,
  buildConnectPath,
  createClientApi,
  resetClientApiSessionRedirect,
} from "@/lib/client-api";

describe("client API session recovery", () => {
  beforeEach(() => {
    resetClientApiSessionRedirect();
  });

  it("preserves the current path, search, and hash in the reconnect URL", () => {
    expect(
      buildConnectPath({
        pathname: "/applications/app-1",
        search: "?view=full",
        hash: "#notes",
      }),
    ).toBe(
      "/connect?next=%2Fapplications%2Fapp-1%3Fview%3Dfull%23notes",
    );
  });

  it("falls back to a safe local destination", () => {
    expect(
      buildConnectPath({
        pathname: "//evil.example",
        search: "?steal=true",
        hash: "",
      }),
    ).toBe("/connect?next=%2F");
  });

  it("navigates only once when concurrent requests return 401", async () => {
    const navigate = jest.fn();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(
      Response.json(
        { error: "Authentication required", code: "unauthorized" },
        { status: 401 },
      ),
    );
    const api = createClientApi(navigate, {
      fetchImpl,
      getLocation: () => ({
        pathname: "/settings",
        search: "?tab=resume",
        hash: "#upload",
      }),
    });

    const results = await Promise.allSettled([
      api("/api/settings"),
      api("/api/settings"),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      "/connect?next=%2Fsettings%3Ftab%3Dresume%23upload",
    );
  });

  it("returns successful JSON and throws a stable typed error for non-401 failures", async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(Response.json({ total: 4 }))
      .mockResolvedValueOnce(
        Response.json(
          { error: "Application not found", code: "not_found" },
          { status: 404 },
        ),
      );
    const api = createClientApi(jest.fn(), {
      fetchImpl,
      getLocation: () => ({ pathname: "/", search: "", hash: "" }),
    });

    await expect(api<{ total: number }>("/api/stats")).resolves.toEqual({
      total: 4,
    });
    await expect(api("/api/applications/missing")).rejects.toMatchObject({
      name: "ClientApiError",
      status: 404,
      code: "not_found",
      message: "Application not found",
    });
  });

  it("allows a later expired session to redirect after a successful reconnect", async () => {
    const navigate = jest.fn();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(
      Response.json({ error: "Authentication required" }, { status: 401 }),
    );
    const api = createClientApi(navigate, {
      fetchImpl,
      getLocation: () => ({ pathname: "/", search: "", hash: "" }),
    });

    await expect(api("/api/stats")).rejects.toBeInstanceOf(ClientApiError);
    resetClientApiSessionRedirect();
    await expect(api("/api/stats")).rejects.toBeInstanceOf(ClientApiError);

    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale 401 that arrives after a new session is connected", async () => {
    const navigate = jest.fn();
    const response = deferred<Response>();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockReturnValueOnce(response.promise);
    const api = createClientApi(navigate, {
      fetchImpl,
      getLocation: () => ({ pathname: "/settings", search: "", hash: "" }),
    });

    const staleRequest = api("/api/settings");
    resetClientApiSessionRedirect();
    response.resolve(
      Response.json({ error: "Authentication required" }, { status: 401 }),
    );

    await expect(staleRequest).rejects.toMatchObject({ status: 401 });
    expect(navigate).not.toHaveBeenCalled();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
