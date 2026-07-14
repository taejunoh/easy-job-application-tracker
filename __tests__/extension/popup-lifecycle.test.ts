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
  permissionRemoval?: boolean | "reject";
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
  const grantedOrigins = new Set<string>();
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
    get: jest.fn(async (keys: string[]) => Object.fromEntries(
      keys.filter((key) => key in storageState).map((key) => [key, storageState[key]])
    )),
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
    storage: { local: storage },
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
    expect(getElement("connectionStatus").textContent).toMatch(/storage|chrome 102/i);
    await expect(api.apiFetch("/api/settings")).rejects.toThrow(/storage|connect/i);
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
});

describe("connection generations", () => {
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
    await Promise.resolve();
    await Promise.resolve();

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
    expect(harness.storage.set).toHaveBeenCalledTimes(1);
    expect(harness.permissions.remove).toHaveBeenCalledTimes(1);
    expect(harness.storageState.connection).toEqual({
      serverUrl: "https://a.example.com",
      invalidated: true,
    });
  });

  it("builds a saved application View URL from the request's captured origin", async () => {
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

    expect(harness.getElement("openTracker").dataset.appUrl).toBe(
      "https://a.example.com/applications/17"
    );
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
      /storage|could not save/i
    );
    await expect(harness.api.apiFetch("/api/settings")).rejects.toThrow();

    const reopened = loadLifecyclePopup({ storageState: harness.storageState });
    await reopened.ready();
    expect(reopened.getElement("connectionStatus").textContent).toMatch(
      /disconnected/i
    );
    expect(reopened.fetchMock).not.toHaveBeenCalled();
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
  return registration[1] as () => Promise<void> | void;
}
