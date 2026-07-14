import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const popupScript = readFileSync(
  join(process.cwd(), "extension/popup.js"),
  "utf8"
);

const TOKEN_A = "obvious-test-token-a";
const TOKEN_B = "obvious-test-token-b";

interface MockElement {
  value: string;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  className: string;
  disabled: boolean;
  dataset: Record<string, string>;
  addEventListener: jest.Mock;
  appendChild: jest.Mock;
  focus: jest.Mock;
  setAttribute: jest.Mock;
}

interface PopupApi {
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  connectServer(): Promise<void>;
  disconnectServer(): Promise<void>;
  initializationPromise?: Promise<void>;
  initializePopup(): Promise<void>;
  restoreConnection(result: Record<string, unknown>): void;
  runKeywordAnalysis(): Promise<void>;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createElement(value = ""): MockElement {
  return {
    value,
    style: { display: "" },
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    dataset: {},
    addEventListener: jest.fn(),
    appendChild: jest.fn(),
    focus: jest.fn(),
    setAttribute: jest.fn(),
  };
}

function loadLifecyclePopup(options: {
  accessLevel?: "resolve" | "reject" | "defer";
  grantedOrigins?: Set<string>;
  permissionRemoval?: boolean | "reject";
  sessionState?: Record<string, unknown>;
  storageGetGate?: {
    promise: Promise<void>;
    resolve(value: void): void;
    reject(error: unknown): void;
  };
  storageState?: Record<string, unknown>;
} = {}) {
  const elements: Record<string, MockElement> = {};
  const getElement = (id: string) => {
    if (!elements[id]) {
      elements[id] = createElement(
        id === "serverUrl" ? "http://localhost:3000" : ""
      );
    }
    return elements[id];
  };

  const storageState = options.storageState ?? {};
  const sessionState = options.sessionState ?? {};
  const grantedOrigins = options.grantedOrigins ?? new Set<string>();
  const accessGate = deferred<void>();
  const accessLevel = options.accessLevel ?? "resolve";
  const setAccessLevel = jest.fn(() => {
    if (accessLevel === "reject") {
      return Promise.reject(new Error("trusted storage unavailable"));
    }
    if (accessLevel === "defer") return accessGate.promise;
    return Promise.resolve();
  });
  const storage = {
    get: jest.fn(async (keys: string[]) => {
      const snapshot = Object.fromEntries(
        keys.filter((key) => key in storageState).map((key) => [key, storageState[key]])
      );
      if (options.storageGetGate) await options.storageGetGate.promise;
      return snapshot;
    }),
    set: jest.fn(async (values: Record<string, unknown>) => {
      Object.assign(storageState, values);
    }),
    remove: jest.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storageState[key];
      }
    }),
    setAccessLevel,
  };
  const session = {
    get: jest.fn(async (keys: string[]) => Object.fromEntries(
      keys.filter((key) => key in sessionState).map((key) => [key, sessionState[key]])
    )),
    set: jest.fn(async (values: Record<string, unknown>) => {
      Object.assign(sessionState, values);
    }),
    remove: jest.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete sessionState[key];
      }
    }),
  };
  const permissions = {
    contains: jest.fn(async ({ origins }: { origins: string[] }) =>
      origins.every((origin) => grantedOrigins.has(origin))
    ),
    request: jest.fn(async ({ origins }: { origins: string[] }) => {
      for (const origin of origins) grantedOrigins.add(origin);
      return true;
    }),
    remove: jest.fn(async ({ origins }: { origins: string[] }) => {
      if (options.permissionRemoval === "reject") {
        throw new Error("permission removal unavailable");
      }
      const removed = options.permissionRemoval ?? true;
      if (removed) {
        for (const origin of origins) grantedOrigins.delete(origin);
      }
      return removed;
    }),
  };
  const fetchMock = jest.fn();
  const query = jest.fn().mockResolvedValue([]);
  const chrome = {
    permissions,
    scripting: { executeScript: jest.fn().mockResolvedValue(undefined) },
    storage: { local: storage, session },
    tabs: {
      create: jest.fn(),
      query,
      sendMessage: jest.fn(),
    },
  };
  const commonJsModule: { exports: Partial<PopupApi> } = { exports: {} };
  const context = vm.createContext({
    chrome,
    document: {
      createElement: jest.fn(() => createElement()),
      getElementById: jest.fn((id: string) => getElement(id)),
    },
    fetch: fetchMock,
    Headers,
    module: commonJsModule,
    URL,
  });

  new vm.Script(popupScript).runInContext(context);

  const api = commonJsModule.exports as PopupApi;
  const initialization = api.initializePopup();
  async function ready() {
    await initialization;
    await Promise.resolve();
    await Promise.resolve();
  }
  function establish(serverUrl: string, accessToken: string) {
    storageState.connection = { serverUrl, accessToken, invalidated: false };
    api.restoreConnection({
      connection: storageState.connection,
      serverUrl,
      accessToken,
    });
    grantedOrigins.add(permissionFor(serverUrl));
  }
  function enterPair(serverUrl: string, token = TOKEN_B) {
    getElement("serverUrl").value = serverUrl;
    getElement("accessToken").value = token;
  }

  return {
    accessGate,
    api,
    chrome,
    enterPair,
    establish,
    fetchMock,
    getElement,
    grantedOrigins,
    permissions,
    ready,
    session,
    sessionState,
    storage,
    storageState,
  };
}

function permissionFor(origin: string) {
  const url = new URL(origin);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${url.hostname}:${port}/*`;
}

describe("trusted extension storage", () => {
  it("awaits trusted-context access before reading stored credentials", async () => {
    const { accessGate, ready, storage } = loadLifecyclePopup({
      accessLevel: "defer",
    });

    await Promise.resolve();
    expect(storage.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    expect(storage.get).not.toHaveBeenCalled();

    accessGate.resolve();
    await ready();
    expect(storage.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(
      storage.get.mock.invocationCallOrder[0]
    );
  });

  it("fails closed without reading or using a token when access-level setup fails", async () => {
    const { api, getElement, ready, storage } = loadLifecyclePopup({
      accessLevel: "reject",
      storageState: {
        connection: {
          serverUrl: "https://jobs.example.com",
          accessToken: TOKEN_A,
          invalidated: false,
        },
      },
    });

    await ready();

    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([
      "connection",
      "serverUrl",
      "accessToken",
    ]);
    expect(getElement("connectionStatus").textContent).toMatch(/storage|chrome 102/i);
    await expect(api.apiFetch("/api/settings")).rejects.toThrow(/storage|connect/i);
  });

  it("fails closed and warns when trusted-storage credential purge also fails", async () => {
    const harness = loadLifecyclePopup({
      accessLevel: "reject",
      storageState: {
        connection: {
          serverUrl: "https://jobs.example.com",
          accessToken: TOKEN_A,
          invalidated: false,
        },
      },
    });
    harness.storage.remove.mockRejectedValueOnce(new Error("storage unavailable"));

    await harness.ready();

    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /purge|remove|credential/i
    );
    expect(harness.fetchMock).not.toHaveBeenCalled();
    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();
  });

  it("does not verify or store a new token when trusted storage is unavailable", async () => {
    const harness = loadLifecyclePopup({ accessLevel: "reject" });
    await harness.ready();
    harness.enterPair("https://jobs.example.com", TOKEN_A);

    await harness.api.connectServer();

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.storage.set).not.toHaveBeenCalled();
    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /storage|chrome 102/i
    );
  });

  it("revalidates a stored token before reporting it connected", async () => {
    const state = {
      connection: {
        serverUrl: "https://jobs.example.com",
        accessToken: TOKEN_A,
        invalidated: false,
      },
    };
    const harness = loadLifecyclePopup({ storageState: state });
    harness.grantedOrigins.add(permissionFor("https://jobs.example.com"));
    harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await harness.ready();

    expect(harness.getElement("connectionStatus").textContent).toMatch(/reconnect/i);
    expect((state.connection as Record<string, unknown>).accessToken).toBeUndefined();
    expect((state.connection as Record<string, unknown>).invalidated).toBe(true);
  });

  it("does not activate a stored token after host access was revoked", async () => {
    const state = {
      connection: {
        serverUrl: "https://jobs.example.com",
        accessToken: TOKEN_A,
        invalidated: false,
      },
    };
    const harness = loadLifecyclePopup({ storageState: state });

    await harness.ready();

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(state.connection).toEqual({
      serverUrl: "https://jobs.example.com",
      invalidated: true,
    });
    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /host access|connect again|reconnect/i
    );
  });

  it("keeps a rejected startup credential inactive but available to Disconnect for purge", async () => {
    const state = {
      connection: {
        serverUrl: "https://jobs.example.com",
        accessToken: TOKEN_A,
        invalidated: false,
      },
    };
    const harness = loadLifecyclePopup({ storageState: state });
    harness.grantedOrigins.add(permissionFor("https://jobs.example.com"));
    harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

    await harness.ready();

    expect(harness.getElement("disconnectBtn").disabled).toBe(false);
    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow(/connect/i);
    await harness.api.disconnectServer();
    expect((state.connection as Record<string, unknown>).accessToken).toBeUndefined();
    expect((state.connection as Record<string, unknown>).invalidated).toBe(true);
  });
});

describe("connection generations", () => {
  it("newest generation wins when startup storage.get returns an old A snapshot after B pairing", async () => {
    const storageGate = deferred<void>();
    const state = {
      connection: {
        serverUrl: "https://a.example.com",
        accessToken: TOKEN_A,
        invalidated: false,
      },
    };
    const harness = loadLifecyclePopup({
      storageGetGate: storageGate,
      storageState: state,
    });
    harness.grantedOrigins.add(permissionFor("https://a.example.com"));
    harness.fetchMock.mockResolvedValue({ ok: true, status: 200 });
    for (let index = 0; index < 20 && !harness.storage.get.mock.calls.length; index += 1) {
      await Promise.resolve();
    }
    expect(harness.storage.get).toHaveBeenCalled();

    harness.enterPair("https://b.example.com");
    await harness.api.connectServer();
    storageGate.resolve();
    await harness.ready();

    expect(state.connection).toEqual({
      serverUrl: "https://b.example.com",
      accessToken: TOKEN_B,
      invalidated: false,
    });
    expect(harness.getElement("connectionStatus").textContent).toContain(
      "https://b.example.com"
    );
    await harness.api.apiFetch("/api/settings");
    const request = harness.fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN_B}`
    );
  });

  it("does not let stale startup verification clear a newly paired connection", async () => {
    const state = {
      connection: {
        serverUrl: "https://a.example.com",
        accessToken: TOKEN_A,
        invalidated: false,
      },
    };
    const harness = loadLifecyclePopup({ storageState: state });
    harness.grantedOrigins.add(permissionFor("https://a.example.com"));
    const startupResponse = deferred<Response>();
    harness.fetchMock
      .mockReturnValueOnce(startupResponse.promise)
      .mockResolvedValueOnce({ ok: true, status: 200 });
    for (let index = 0; index < 50 && !harness.fetchMock.mock.calls.length; index += 1) {
      await Promise.resolve();
    }
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);

    harness.enterPair("https://b.example.com");
    await harness.api.connectServer();
    startupResponse.resolve({ ok: false, status: 401 } as Response);
    await harness.ready();

    expect(state.connection).toEqual({
      serverUrl: "https://b.example.com",
      accessToken: TOKEN_B,
      invalidated: false,
    });
  });

  it("does not let a stale 401 from A clear a successfully paired B", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    const responseA = deferred<Response>();
    harness.fetchMock
      .mockReturnValueOnce(responseA.promise)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const requestA = harness.api.apiFetch("/api/settings");
    harness.enterPair("https://b.example.com");
    await harness.api.connectServer();
    responseA.resolve({ ok: false, status: 401 } as Response);

    await expect(requestA).rejects.toThrow(/reconnect|expired/i);
    expect(harness.storageState.connection).toEqual({
      serverUrl: "https://b.example.com",
      accessToken: TOKEN_B,
      invalidated: false,
    });
    expect(harness.permissions.remove).toHaveBeenCalledTimes(1);
    expect(harness.permissions.remove).toHaveBeenCalledWith({
      origins: [permissionFor("https://a.example.com")],
    });

    harness.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await harness.api.apiFetch("/api/settings");
    const lastInit = harness.fetchMock.mock.calls[2][1] as RequestInit;
    expect(new Headers(lastInit.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN_B}`
    );
  });

  it("newest generation wins when same-origin reconnect races an old 401", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    const oldResponse = deferred<Response>();
    const pairResponse = deferred<Response>();
    harness.fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(pairResponse.promise);

    const oldRequest = harness.api.apiFetch("/api/settings");
    harness.enterPair("https://a.example.com", TOKEN_B);
    const reconnect = harness.api.connectServer();
    oldResponse.resolve({ ok: false, status: 401 } as Response);
    await Promise.resolve();
    pairResponse.resolve({ ok: true, status: 200 } as Response);

    await reconnect;
    await expect(oldRequest).rejects.toThrow(/reconnect|expired/i);
    expect(harness.storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      accessToken: TOKEN_B,
      invalidated: false,
    });
    expect(harness.grantedOrigins).toContain(permissionFor("https://a.example.com"));
    expect(harness.getElement("connectionStatus").textContent).toMatch(/connected/i);
  });

  it("newest generation status wins when B gets 401 during A permission cleanup", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    const oldCleanup = deferred<boolean>();
    harness.permissions.remove.mockImplementationOnce(async ({ origins }) => {
      const removed = await oldCleanup.promise;
      if (removed) origins.forEach((origin: string) => harness.grantedOrigins.delete(origin));
      return removed;
    });
    harness.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    harness.enterPair("https://b.example.com");

    const reconnect = harness.api.connectServer();
    for (let index = 0; index < 50 && !harness.permissions.remove.mock.calls.length; index += 1) {
      await Promise.resolve();
    }
    expect(harness.permissions.remove).toHaveBeenCalledWith({
      origins: [permissionFor("https://a.example.com")],
    });

    harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const requestB = harness.api.apiFetch("/api/settings");
    await Promise.resolve();
    oldCleanup.resolve(true);
    await reconnect;
    await expect(requestB).rejects.toThrow(/reconnect|expired/i);

    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /expired|reconnect/i
    );
    expect((harness.storageState.connection as Record<string, unknown>).invalidated)
      .toBe(true);
  });

  it("does not store a token when commit-time host access is missing", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.permissions.contains
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    harness.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    harness.enterPair("https://b.example.com");

    await harness.api.connectServer();

    expect(harness.storageState.connection).toBeUndefined();
    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /click connect again|server access.*changed/i
    );
    expect(harness.permissions.request.mock.invocationCallOrder[0]).toBeLessThan(
      harness.fetchMock.mock.invocationCallOrder[0]
    );
  });

  it("invalidates storage and permission once for concurrent same-generation 401s", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    const first = deferred<Response>();
    const second = deferred<Response>();
    harness.fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const requests = [
      harness.api.apiFetch("/api/settings"),
      harness.api.apiFetch("/api/applications"),
    ];
    first.resolve({ ok: false, status: 401 } as Response);
    second.resolve({ ok: false, status: 401 } as Response);

    await Promise.all(requests.map((request) => expect(request).rejects.toThrow()));
    // Persist cleanup intent before attempting permission removal, then clear
    // the intent after the removal succeeds.
    expect(harness.storage.set).toHaveBeenCalledTimes(2);
    expect(harness.permissions.remove).toHaveBeenCalledTimes(1);
    expect(harness.storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
    });
  });

  it("does not revive a stale saved-application target after reconnect", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.getElement("jobTitle").value = "Engineer";
    harness.getElement("company").value = "Example";
    const responseA = deferred<Response>();
    harness.fetchMock
      .mockReturnValueOnce(responseA.promise)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const save = eventHandler(harness.getElement("saveBtn"), "click")();
    harness.enterPair("https://b.example.com");
    await harness.api.connectServer();
    responseA.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: 17, updated: false }),
    } as Response);
    await save;

    expect(harness.getElement("openTracker").dataset.appUrl).toBeUndefined();
  });

  it("uses the keyword request's captured origin for the no-resume Settings link", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.getElement("description").value = "TypeScript and security";
    const analysisResponse = deferred<Response>();
    harness.fetchMock
      .mockReturnValueOnce(analysisResponse.promise)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const analysis = harness.api.runKeywordAnalysis();
    harness.enterPair("https://b.example.com");
    await harness.api.connectServer();
    analysisResponse.resolve({
      ok: true,
      status: 200,
      json: async () => ({ error: "no_resume" }),
    } as Response);
    await analysis;
    eventHandler(harness.getElement("openSettings"), "click")({
      preventDefault: jest.fn(),
    });

    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://a.example.com/settings",
    });
  });
});

describe("connection teardown", () => {
  it("disconnects atomically, retains the URL draft, and removes host access", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.getElement("openTracker").dataset.appUrl =
      "https://a.example.com/applications/17";

    await harness.api.disconnectServer();

    expect(harness.storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
    });
    expect(harness.getElement("serverUrl").value).toBe("https://a.example.com");
    expect(harness.getElement("openTracker").dataset.appUrl).toBeUndefined();
    expect(harness.permissions.remove).toHaveBeenCalledWith({
      origins: [permissionFor("https://a.example.com")],
    });
    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();
  });

  it.each([false, "reject"] as const)(
    "warns but stays disconnected when permission removal is %s",
    async (permissionRemoval) => {
      const harness = loadLifecyclePopup({ permissionRemoval });
      await harness.ready();
      harness.establish("https://a.example.com", TOKEN_A);

      await harness.api.disconnectServer();

      expect(harness.getElement("connectionStatus").textContent).toMatch(
        /could not remove|host access/i
      );
      expect((harness.storageState.connection as Record<string, unknown>).accessToken)
        .toBeUndefined();
      await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();
    }
  );

  it("disconnects and warns when 401 persistence fails", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.storage.set.mockRejectedValueOnce(new Error("storage unavailable"));
    harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow(/reconnect/i);

    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /expired|reconnect/i
    );
    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();

    const reopened = loadLifecyclePopup({ storageState: harness.storageState });
    await reopened.ready();
    expect(reopened.getElement("connectionStatus").textContent).toMatch(
      /disconnected/i
    );
    expect(reopened.fetchMock).not.toHaveBeenCalled();
  });

  it("explicit disconnect stays durable after local tombstone set and purge both fail", async () => {
    const storageState: Record<string, unknown> = {};
    const sessionState: Record<string, unknown> = {};
    const grantedOrigins = new Set<string>();
    const harness = loadLifecyclePopup({
      grantedOrigins,
      sessionState,
      storageState,
    });
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.storage.set.mockRejectedValueOnce(new Error("set unavailable"));
    harness.storage.remove.mockRejectedValueOnce(new Error("remove unavailable"));

    await harness.api.disconnectServer();

    expect(sessionState).toEqual(expect.objectContaining({
      connectionTombstone: expect.objectContaining({
        serverUrl: "https://a.example.com",
      }),
    }));
    expect(harness.getElement("connectionStatus").textContent).toMatch(/storage|purge/i);

    const reopened = loadLifecyclePopup({
      grantedOrigins,
      sessionState,
      storageState,
    });
    reopened.fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await reopened.ready();

    expect(reopened.fetchMock).not.toHaveBeenCalled();
    expect(reopened.getElement("connectionStatus").textContent).toMatch(/disconnected/i);
    await expect(reopened.api.apiFetch("/api/settings")).rejects.toThrow();
  });

  it("retries a persisted disconnect permission cleanup on next startup", async () => {
    const storageState: Record<string, unknown> = {};
    const sessionState: Record<string, unknown> = {};
    const grantedOrigins = new Set<string>();
    const first = loadLifecyclePopup({
      grantedOrigins,
      permissionRemoval: false,
      sessionState,
      storageState,
    });
    await first.ready();
    first.establish("https://a.example.com", TOKEN_A);

    await first.api.disconnectServer();

    expect(storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
      pendingCleanupOrigins: ["https://a.example.com"],
    });
    expect(grantedOrigins).toContain(permissionFor("https://a.example.com"));

    const reopened = loadLifecyclePopup({
      grantedOrigins,
      sessionState,
      storageState,
    });
    await reopened.ready();

    expect(reopened.permissions.remove).toHaveBeenCalledWith({
      origins: [permissionFor("https://a.example.com")],
    });
    expect(grantedOrigins).not.toContain(permissionFor("https://a.example.com"));
    expect(storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
    });
  });

  it("persists and retries old-origin cleanup after a successful server change", async () => {
    const storageState: Record<string, unknown> = {};
    const grantedOrigins = new Set<string>();
    const first = loadLifecyclePopup({
      grantedOrigins,
      permissionRemoval: false,
      storageState,
    });
    await first.ready();
    first.establish("https://a.example.com", TOKEN_A);
    first.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    first.enterPair("https://b.example.com");

    await first.api.connectServer();

    expect(storageState.connection).toEqual({
      serverUrl: "https://b.example.com",
      accessToken: TOKEN_B,
      invalidated: false,
      pendingCleanupOrigins: ["https://a.example.com"],
    });

    const reopened = loadLifecyclePopup({ grantedOrigins, storageState });
    reopened.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await reopened.ready();

    expect(grantedOrigins).not.toContain(permissionFor("https://a.example.com"));
    expect(storageState.connection).toEqual({
      serverUrl: "https://b.example.com",
      accessToken: TOKEN_B,
      invalidated: false,
    });
  });

  it("persists and retries cleanup after a newly granted connection fails verification", async () => {
    const storageState: Record<string, unknown> = {};
    const grantedOrigins = new Set<string>();
    const first = loadLifecyclePopup({
      grantedOrigins,
      permissionRemoval: false,
      storageState,
    });
    await first.ready();
    first.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    first.enterPair("https://new.example.com");

    await first.api.connectServer();

    expect(storageState.connection).toEqual({
      serverUrl: "https://new.example.com",
      invalidated: true,
      pendingCleanupOrigins: ["https://new.example.com"],
    });

    const reopened = loadLifecyclePopup({ grantedOrigins, storageState });
    await reopened.ready();
    expect(grantedOrigins).not.toContain(permissionFor("https://new.example.com"));
    expect(storageState.connection).toEqual({
      serverUrl: "https://new.example.com",
      invalidated: true,
    });
  });

  it("persists and retries 401 permission cleanup on next startup", async () => {
    const storageState: Record<string, unknown> = {};
    const grantedOrigins = new Set<string>();
    const first = loadLifecyclePopup({
      grantedOrigins,
      permissionRemoval: false,
      storageState,
    });
    await first.ready();
    first.establish("https://a.example.com", TOKEN_A);
    first.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(first.api.apiFetch("/api/settings")).rejects.toThrow();

    expect(storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
      pendingCleanupOrigins: ["https://a.example.com"],
    });

    const reopened = loadLifecyclePopup({ grantedOrigins, storageState });
    await reopened.ready();
    expect(grantedOrigins).not.toContain(permissionFor("https://a.example.com"));
    expect(storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
    });
  });

  it("handles a false legacy cleanup result during successful startup migration", async () => {
    const storageState: Record<string, unknown> = {
      serverUrl: "https://a.example.com",
      accessToken: TOKEN_A,
    };
    const grantedOrigins = new Set([permissionFor("https://a.example.com")]);
    const harness = loadLifecyclePopup({ grantedOrigins, storageState });
    harness.storage.remove.mockRejectedValueOnce(new Error("legacy cleanup failed"));
    harness.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await harness.ready();

    expect(storageState.accessToken).toBeUndefined();
    expect(storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      accessToken: TOKEN_A,
      invalidated: false,
    });
    expect(harness.getElement("connectionStatus").textContent).toMatch(/connected/i);
  });

  it("does not report Connected when an unsafe session tombstone cannot be cleared", async () => {
    const storageState: Record<string, unknown> = {};
    const sessionState: Record<string, unknown> = {};
    const harness = loadLifecyclePopup({ sessionState, storageState });
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.storage.set.mockRejectedValueOnce(new Error("set unavailable"));
    harness.storage.remove.mockRejectedValueOnce(new Error("purge unavailable"));
    await harness.api.disconnectServer();
    expect(sessionState.connectionTombstone).toBeDefined();

    harness.session.remove.mockRejectedValueOnce(new Error("session unavailable"));
    harness.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    harness.enterPair("https://a.example.com", TOKEN_B);
    await harness.api.connectServer();

    expect(harness.getElement("connectionStatus").textContent).not.toMatch(/^Connected/i);
    expect(sessionState.connectionTombstone).toBeDefined();
    expect((storageState.connection as Record<string, unknown>).accessToken).toBeUndefined();
    expect((storageState.connection as Record<string, unknown>).invalidated).toBe(true);
    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();
  });

  it("handles failed legacy-key cleanup while persisting a 401 invalidation", async () => {
    const storageState: Record<string, unknown> = {};
    const harness = loadLifecyclePopup({ storageState });
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    storageState.serverUrl = "https://a.example.com";
    storageState.accessToken = TOKEN_A;
    harness.storage.remove.mockRejectedValueOnce(new Error("legacy cleanup failed"));
    harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();

    expect(storageState.accessToken).toBeUndefined();
    expect(harness.getElement("connectionStatus").textContent).toMatch(
      /expired|reconnect/i
    );
  });

  it("does not revive a stale saved-application target after disconnect", async () => {
    const harness = loadLifecyclePopup();
    await harness.ready();
    harness.establish("https://a.example.com", TOKEN_A);
    harness.getElement("jobTitle").value = "Engineer";
    harness.getElement("company").value = "Example";
    const response = deferred<Response>();
    harness.fetchMock.mockReturnValueOnce(response.promise);

    const save = eventHandler(harness.getElement("saveBtn"), "click")();
    await harness.api.disconnectServer();
    response.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: 17, updated: false }),
    } as Response);
    await save;

    expect(harness.getElement("openTracker").dataset.appUrl).toBeUndefined();
  });

  it.each([false, "reject"] as const)(
    "keeps a 401-invalidated connection disconnected when host cleanup is %s",
    async (permissionRemoval) => {
      const harness = loadLifecyclePopup({ permissionRemoval });
      await harness.ready();
      harness.establish("https://a.example.com", TOKEN_A);
      harness.getElement("openTracker").dataset.appUrl =
        "https://a.example.com/applications/17";
      harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

      await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();

      expect(harness.getElement("connectionStatus").textContent).toMatch(
        /host access/i
      );
      expect(harness.getElement("openTracker").dataset.appUrl).toBeUndefined();
      expect(harness.storageState.connection).toEqual({
        serverUrl: "https://a.example.com",
        invalidated: true,
        pendingCleanupOrigins: ["https://a.example.com"],
      });
    }
  );

  it.each([false, "reject"] as const)(
    "surfaces failed cleanup of a newly granted permission (%s)",
    async (permissionRemoval) => {
      const harness = loadLifecyclePopup({ permissionRemoval });
      await harness.ready();
      harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      harness.enterPair("https://new.example.com");

      await harness.api.connectServer();

      expect(harness.getElement("connectionStatus").textContent).toMatch(
        /could not remove|host access/i
      );
    }
  );

  it.each([false, "reject"] as const)(
    "keeps a successful new connection and warns when old access cleanup is %s",
    async (permissionRemoval) => {
      const harness = loadLifecyclePopup({ permissionRemoval });
      await harness.ready();
      harness.establish("https://a.example.com", TOKEN_A);
      harness.getElement("openTracker").dataset.appUrl =
        "https://a.example.com/applications/17";
      harness.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
      harness.enterPair("https://b.example.com");

      await harness.api.connectServer();

      expect(harness.storageState.connection).toEqual({
        serverUrl: "https://b.example.com",
        accessToken: TOKEN_B,
        invalidated: false,
        pendingCleanupOrigins: ["https://a.example.com"],
      });
      expect(harness.getElement("connectionStatus").textContent).toMatch(
        /connected.*could not remove|host access/i
      );
      expect(harness.getElement("openTracker").dataset.appUrl).toBeUndefined();
    }
  );
});

function eventHandler(element: MockElement, eventName: string) {
  const registration = element.addEventListener.mock.calls.find(
    ([registeredEvent]) => registeredEvent === eventName
  );
  if (!registration) throw new Error(`Missing ${eventName} event handler`);
  return registration[1] as (event?: { preventDefault(): void }) => Promise<void> | void;
}
