import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const popupScript = readFileSync(
  join(process.cwd(), "extension/popup.js"),
  "utf8"
);
const popupHtml = readFileSync(
  join(process.cwd(), "extension/popup.html"),
  "utf8"
);
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "extension/manifest.json"), "utf8")
) as Record<string, unknown>;

const TEST_TOKEN =
  "jt_install_v1.018f9f72-f2e9-7c29-a6fc-001122334491." + "A".repeat(43);
const PAIRED_TOKEN =
  "jt_install_v1.018f9f72-f2e9-7c29-a6fc-001122334492." + "B".repeat(43);
const PAIRING_CODE =
  "jt_pair_v1.018f9f72-f2e9-7c29-a6fc-001122334488." + "C".repeat(43);

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
  sendMessageWithRetry(
    tabId: number,
    message: Record<string, unknown>
  ): Promise<unknown>;
  extractFromPage(): Promise<void>;
  runKeywordAnalysis(): Promise<void>;
  fillProfiles(): Promise<void>;
  serverExtract(url: string): Promise<unknown>;
  normalizeServerOrigin(value: string): string;
  permissionPattern(origin: string): string;
  restoreConnection(result: {
    serverUrl?: string;
    installationId?: string;
    installationToken?: string;
  }): void;
  initializePopup(): Promise<void>;
  connectServer(): Promise<void>;
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
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

function successfulPairResponse(): Response {
  return {
    ok: true,
    status: 201,
    json: async () => ({
      installationId: "018f9f72-f2e9-7c29-a6fc-001122334492",
      token: PAIRED_TOKEN,
      expiresAt: "2026-11-11T12:00:00.000Z",
    }),
  } as Response;
}

function loadPopup(options: {
  connection?: {
    serverUrl?: string;
    installationId?: string;
    installationToken?: string;
  };
  permissionGranted?: boolean;
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

  const sendMessage = jest.fn();
  const executeScript = jest.fn().mockResolvedValue(undefined);
  const query = jest.fn();
  const fetchMock = jest.fn();
  let permissionGranted = options.permissionGranted ?? true;
  const permissions = {
    contains: jest.fn(async () => permissionGranted),
    request: jest.fn(async () => {
      permissionGranted = true;
      return true;
    }),
    remove: jest.fn(async () => {
      const removed = permissionGranted;
      permissionGranted = false;
      return removed;
    }),
  };
  const storage = {
    get: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    setAccessLevel: jest.fn().mockResolvedValue(undefined),
  };
  const chrome = {
    permissions,
    tabs: {
      create: jest.fn(),
      query,
      sendMessage,
    },
    scripting: { executeScript },
    storage: {
      local: storage,
    },
  };
  const commonJsModule: { exports: Partial<PopupApi> } = { exports: {} };
  const context = vm.createContext({
    chrome,
    console: {
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    },
    document: {
      createElement: jest.fn(() => createElement()),
      getElementById: jest.fn((id: string) => getElement(id)),
    },
    exports: commonJsModule.exports,
    fetch: fetchMock,
    Headers,
    module: commonJsModule,
    AbortController,
    clearTimeout,
    setTimeout,
    URL,
  });

  new vm.Script(popupScript).runInContext(context);

  commonJsModule.exports.restoreConnection?.(
    options.connection ?? {
      serverUrl: "http://localhost:3000",
      installationId: "018f9f72-f2e9-7c29-a6fc-001122334491",
      installationToken: TEST_TOKEN,
    }
  );

  return {
    api: commonJsModule.exports as PopupApi,
    chrome,
    elements,
    executeScript,
    fetchMock,
    getElement,
    permissions,
    query,
    sendMessage,
    storage,
  };
}

function eventHandler(element: MockElement, eventName: string) {
  const registration = element.addEventListener.mock.calls.find(
    ([registeredEvent]) => registeredEvent === eventName
  );
  if (!registration) throw new Error(`Missing ${eventName} event handler`);
  return registration[1] as () => Promise<void> | void;
}

describe("extension connection configuration", () => {
  it("declares scoped optional host permissions without all-URLs access", () => {
    expect(manifest.optional_host_permissions).toEqual([
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
    expect(manifest.permissions).toEqual([
      "activeTab",
      "scripting",
      "storage",
    ]);
    // Generic StorageArea.setAccessLevel docs say Chrome 102+, but Chromium
    // commit a8f1f337c692360aaec9470a0a91f965011d37a3 enabled the local/sync
    // implementations in the M140 development cycle.
    expect(manifest.minimum_chrome_version).toBe("140");
    expect(popupScript).toContain("requires Chrome 140 or newer");
    expect(manifest.background).toEqual({ service_worker: "background.js" });
  });

  it("renders an accessible compact connection form with a blank password field", () => {
    expect(popupHtml).toContain('for="serverUrl"');
    expect(popupHtml).toContain('id="serverUrl"');
    expect(popupHtml).toContain('for="accessToken"');
    expect(popupHtml).toContain('id="accessToken"');
    expect(popupHtml).toContain('type="password"');
    expect(popupHtml).toContain('id="connectBtn"');
    expect(popupHtml).toContain('id="disconnectBtn"');
    expect(popupHtml).toContain('id="connectionStatus"');
    expect(popupHtml).toMatch(/id="connectionStatus"[^>]+aria-live="polite"/);
    expect(popupHtml).toMatch(/<button[^>]+id="analysisToggle"[^>]+aria-expanded="true"/);
  });

  it("keeps keyword analysis disclosure state in sync", async () => {
    const { getElement } = loadPopup();
    const toggle = getElement("analysisToggle");
    const body = getElement("analysisBody");

    await eventHandler(toggle, "click")();

    expect(body.style.display).toBe("none");
    expect(toggle.setAttribute).toHaveBeenCalledWith("aria-expanded", "false");
  });
});

describe("server origin policy", () => {
  it.each([
    ["https://Jobs.Example.com/", "https://jobs.example.com"],
    ["https://jobs.example.com:443", "https://jobs.example.com"],
    ["https://jobs.example.com:8443/", "https://jobs.example.com:8443"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ])("normalizes %s to its exact origin", (value, expected) => {
    const { api } = loadPopup();
    expect(api.normalizeServerOrigin(value)).toBe(expected);
  });

  it.each([
    ["https://jobs.example.com", "https://jobs.example.com:443/*"],
    ["https://jobs.example.com:8443", "https://jobs.example.com:8443/*"],
    ["http://localhost", "http://localhost:80/*"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000/*"],
    ["https://[2001:db8::1]", "https://[2001:db8::1]:443/*"],
  ])("derives the effective-port host permission for %s", (origin, expected) => {
    const { api } = loadPopup();
    expect(api.permissionPattern(origin)).toBe(expected);
  });

  it.each([
    "",
    "jobs.example.com",
    "https:jobs.example.com",
    "ftp://jobs.example.com",
    "http://jobs.example.com",
    "http://0.0.0.0:3000",
    "http://[::1]:3000",
    "https://@jobs.example.com",
    "https://user:password@jobs.example.com",
    "https://jobs.example.com/api",
    "https://jobs.example.com/.",
    "https://jobs.example.com/jobs/..",
    "https://jobs.example.com\\api",
    "https://jobs.example.com/?",
    "https://jobs.example.com/#",
    "https://jobs.example.com/?draft=1",
    "https://jobs.example.com/#connect",
  ])("rejects unsafe or non-origin server URL %s", (value) => {
    const { api } = loadPopup();
    expect(() => api.normalizeServerOrigin(value)).toThrow();
  });
});

describe("secure extension pairing", () => {
  function enterPair(
    getElement: (id: string) => MockElement,
    serverUrl = "https://new.example.com/"
  ) {
    getElement("serverUrl").value = serverUrl;
    getElement("accessToken").value = PAIRING_CODE;
  }

  it("does not store or verify when the selected origin permission is denied", async () => {
    const { api, fetchMock, getElement, permissions, storage } = loadPopup({
      permissionGranted: false,
    });
    permissions.request.mockResolvedValueOnce(false);
    enterPair(getElement);

    await api.connectServer();

    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://new.example.com:443/*"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(getElement("connectionStatus").textContent).toMatch(/not granted/i);
    expect(getElement("accessToken").value).toBe("");

    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    await api.apiFetch("/api/settings");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:3000/api/settings",
      expect.any(Object)
    );
  });

  it("invokes the permission request synchronously from the Connect path", async () => {
    const { api, fetchMock, getElement, permissions } = loadPopup({
      permissionGranted: false,
    });
    let resolveContains: (value: boolean) => void = () => undefined;
    permissions.contains.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveContains = resolve;
      })
    );
    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    enterPair(getElement);

    const pairing = api.connectServer();
    expect(permissions.request).toHaveBeenCalledTimes(1);

    resolveContains(false);
    await pairing;
  });

  it.each(["contains", "request"] as const)(
    "resets Connect UI when permissions.%s throws synchronously",
    async (method) => {
      const { api, getElement, permissions } = loadPopup();
      permissions[method].mockImplementationOnce(() => {
        throw new Error("permissions API unavailable");
      });
      enterPair(getElement);

      await expect(api.connectServer()).resolves.toBeUndefined();

      expect(getElement("connectBtn").disabled).toBe(false);
      expect(getElement("connectBtn").textContent).toBe("Connect");
      expect(getElement("accessToken").value).toBe("");
      expect(getElement("connectionStatus").textContent).toMatch(
        /not granted|permission|server access/i
      );
    }
  );

  it.each([
    [401, /pairing code/i],
    [403, /not allowed/i],
  ])(
    "keeps the previous connection and removes a newly granted permission after verify %s",
    async (status, message) => {
      const { api, fetchMock, getElement, permissions, storage } = loadPopup({
        connection: {
          serverUrl: "https://old.example.com",
          installationToken: TEST_TOKEN,
        },
        permissionGranted: false,
      });
      fetchMock.mockResolvedValueOnce({ ok: false, status });
      enterPair(getElement);

      await api.connectServer();

      expect(storage.set).not.toHaveBeenCalled();
      expect(permissions.remove).toHaveBeenCalledWith({
        origins: ["https://new.example.com:443/*"],
      });
      expect(getElement("connectionStatus").textContent).toMatch(message);

      fetchMock.mockResolvedValueOnce(successfulPairResponse());
      await api.apiFetch("/api/settings");
      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://old.example.com/api/settings",
        expect.any(Object)
      );
    }
  );

  it("cleans up a newly granted permission after a verify network failure", async () => {
    const { api, fetchMock, getElement, permissions, storage } = loadPopup({
      permissionGranted: false,
    });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    enterPair(getElement);

    await api.connectServer();

    expect(storage.set).not.toHaveBeenCalled();
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://new.example.com:443/*"],
    });
    expect(getElement("connectionStatus").textContent).toMatch(/could not reach/i);
  });

  it.each(["401", "network"])(
    "preserves a same-origin permission when prior permission state is unknown after %s failure",
    async (failure) => {
      const { api, fetchMock, getElement, permissions, storage } = loadPopup({
        connection: {
          serverUrl: "https://same.example.com",
          installationToken: TEST_TOKEN,
        },
      });
      permissions.contains.mockRejectedValueOnce(new Error("permission state unavailable"));
      if (failure === "401") {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      } else {
        fetchMock.mockRejectedValueOnce(new Error("offline"));
      }
      enterPair(getElement, "https://same.example.com");

      await api.connectServer();

      expect(storage.set).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(permissions.remove).not.toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce(successfulPairResponse());
      await api.apiFetch("/api/settings");
      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(new Headers(init.headers).get("Authorization")).toBe(
        `Bearer ${TEST_TOKEN}`
      );
    }
  );

  it("does not remove a different-origin permission when its prior state is unknown", async () => {
    const { api, fetchMock, getElement, permissions, storage } = loadPopup({
      connection: {
        serverUrl: "https://old.example.com",
        installationToken: TEST_TOKEN,
      },
    });
    permissions.contains.mockRejectedValueOnce(new Error("permission state unavailable"));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    enterPair(getElement, "https://new.example.com");

    await api.connectServer();

    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("stores the exact origin and token only after permission and verification succeed", async () => {
    const { api, fetchMock, getElement, permissions, storage } = loadPopup({
      connection: { serverUrl: "http://localhost:3000" },
      permissionGranted: false,
    });
    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    enterPair(getElement, "https://NEW.example.com:443/");

    await api.connectServer();

    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://new.example.com:443/*"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [pairUrl, pairInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(pairUrl).toBe("https://new.example.com/api/extension/pair");
    expect(pairInit.method).toBe("POST");
    expect(JSON.parse(String(pairInit.body))).toEqual({ code: PAIRING_CODE });
    expect(new Headers(pairInit.headers).get("Authorization")).toBeNull();
    expect(storage.set).toHaveBeenCalledWith({
      connection: {
        serverUrl: "https://new.example.com",
        installationId: "018f9f72-f2e9-7c29-a6fc-001122334492",
        installationToken: PAIRED_TOKEN,
        invalidated: false,
      },
    });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      storage.set.mock.invocationCallOrder[0]
    );
    expect(getElement("accessToken").value).toBe("");
    expect(getElement("connectionStatus").textContent).toMatch(/connected/i);
  });

  it("retains the previous pair and cleans up the new permission when storage fails", async () => {
    const { api, fetchMock, getElement, permissions, storage } = loadPopup({
      connection: {
        serverUrl: "https://old.example.com",
        installationToken: TEST_TOKEN,
      },
      permissionGranted: false,
    });
    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    storage.set.mockRejectedValueOnce(new Error("storage unavailable"));
    enterPair(getElement);

    await api.connectServer();

    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://new.example.com:443/*"],
    });
    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    await api.apiFetch("/api/settings");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://old.example.com/api/settings",
      expect.any(Object)
    );
  });

  it("removes an old origin only after storing a verified server change", async () => {
    const { api, fetchMock, getElement, permissions, storage } = loadPopup({
      connection: {
        serverUrl: "https://old.example.com",
        installationToken: TEST_TOKEN,
      },
    });
    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    enterPair(getElement);

    await api.connectServer();

    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://old.example.com:443/*"],
    });
    expect(storage.set.mock.invocationCallOrder[0]).toBeLessThan(
      permissions.remove.mock.invocationCallOrder[0]
    );
  });

  it("does not remove a host permission when reconnecting to the same origin", async () => {
    const { api, fetchMock, getElement, permissions } = loadPopup({
      connection: {
        serverUrl: "https://same.example.com",
        installationToken: TEST_TOKEN,
      },
    });
    fetchMock.mockResolvedValueOnce(successfulPairResponse());
    enterPair(getElement, "https://same.example.com/");

    await api.connectServer();

    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it("keeps an upgraded stored URL as a disconnected draft without revealing a token", () => {
    const { api, getElement } = loadPopup({ connection: {} });

    api.restoreConnection({ serverUrl: "http://localhost:3000" });

    expect(getElement("serverUrl").value).toBe("http://localhost:3000");
    expect(getElement("accessToken").value).toBe("");
    expect(getElement("connectionStatus").textContent).toMatch(/legacy|pair/i);
  });

  it("shows a stored pair as connected without placing its token in the DOM", () => {
    const { api, getElement } = loadPopup({ connection: {} });

    api.restoreConnection({
      serverUrl: "https://jobs.example.com",
      installationToken: TEST_TOKEN,
    });

    expect(getElement("serverUrl").value).toBe("https://jobs.example.com");
    expect(getElement("accessToken").value).toBe("");
    expect(getElement("connectionStatus").textContent).toMatch(/connected/i);
  });

  it("loads both persisted connection fields before popup extraction", async () => {
    const { api, fetchMock, getElement, query, storage } = loadPopup({
      connection: {},
    });
    query.mockResolvedValueOnce([]);
    storage.get.mockResolvedValueOnce({
      serverUrl: "https://jobs.example.com",
      installationToken: TEST_TOKEN,
    });
    fetchMock.mockResolvedValueOnce(successfulPairResponse());

    await api.initializePopup();

    expect(storage.get).toHaveBeenCalledWith([
      "connection",
      "serverUrl",
      "accessToken",
      "installationId",
      "installationToken",
    ]);

    expect(getElement("serverUrl").value).toBe("https://jobs.example.com");
    expect(getElement("accessToken").value).toBe("");
    expect(api.apiFetch).toBeDefined();
  });
});

describe("authenticated extension API client", () => {
  it("adds Bearer authentication while preserving caller headers and body", async () => {
    const { api, fetchMock } = loadPopup();
    const response = { ok: true, status: 200 };
    fetchMock.mockResolvedValueOnce(response);

    await expect(
      api.apiFetch("/api/applications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Kind": "popup",
        },
        body: '{"jobTitle":"Engineer"}',
      })
    ).resolves.toBe(response);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:3000/api/applications");
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Request-Kind")).toBe("popup");
    expect(init.body).toBe('{"jobTitle":"Engineer"}');
  });

  it("clears the installation secret and asks for re-pairing after a 401", async () => {
    const { api, fetchMock, getElement, storage } = loadPopup();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(api.apiFetch("/api/settings")).rejects.toThrow(/reconnect/i);

    expect(storage.set).toHaveBeenLastCalledWith({
      connection: {
        serverUrl: "http://localhost:3000",
        installationId: "018f9f72-f2e9-7c29-a6fc-001122334491",
        invalidated: true,
      },
    });
    expect(storage.remove).toHaveBeenCalledWith([
      "serverUrl",
      "accessToken",
      "installationId",
      "installationToken",
    ]);
    expect(getElement("serverUrl").value).toBe("http://localhost:3000");
    expect(getElement("connectionStatus").textContent).toMatch(/reconnect/i);
    await expect(api.apiFetch("/api/settings")).rejects.toThrow(
      /connect.*server/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the reconnect error readable if credential cleanup itself fails", async () => {
    const { api, fetchMock, getElement, storage } = loadPopup();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    storage.remove.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(api.apiFetch("/api/settings")).rejects.toThrow(/reconnect/i);

    expect(getElement("connectionStatus").textContent).toMatch(/reconnect/i);
  });

  it("does not clear the token for non-401 or CORS-style failures", async () => {
    const { api, fetchMock, storage } = loadPopup();
    const forbidden = { ok: false, status: 403 };
    fetchMock.mockResolvedValueOnce(forbidden);

    await expect(api.apiFetch("/api/settings")).resolves.toBe(forbidden);
    expect(storage.remove).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.apiFetch("/api/settings")).rejects.toThrow(
      "Failed to fetch"
    );
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("uses the authenticated client for extract, keyword, applications, and settings", async () => {
    const { api, fetchMock, getElement } = loadPopup();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ jobTitle: "Engineer", company: "Example" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ totalJobKeywords: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 17, result: "created" }),
      });

    await api.serverExtract("https://jobs.example.com/role");
    getElement("description").value = "TypeScript and React";
    await api.runKeywordAnalysis();
    await api.fillProfiles();

    getElement("jobTitle").value = "Engineer";
    getElement("company").value = "Example";
    getElement("jobUrl").value = "https://jobs.example.com/role";
    await eventHandler(getElement("saveBtn"), "click")();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:3000/api/extract",
      "http://localhost:3000/api/keyword-analysis",
      "http://localhost:3000/api/extension/profile",
      "http://localhost:3000/api/applications",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("Authorization")).toBe(
        `Bearer ${TEST_TOKEN}`
      );
    }
  });

  it("requires a URL before sending an application create request", async () => {
    const { fetchMock, getElement } = loadPopup();
    getElement("jobTitle").value = "Engineer";
    getElement("company").value = "Example";
    getElement("jobUrl").value = "";

    await eventHandler(getElement("saveBtn"), "click")();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getElement("statusMsg").textContent).toMatch(/job URL.*required/i);
  });

  it("reports an existing identity without claiming it was updated", async () => {
    const { fetchMock, getElement } = loadPopup();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 17, result: "existing" }),
    });
    getElement("jobTitle").value = "Engineer";
    getElement("company").value = "Example";
    getElement("jobUrl").value = "https://jobs.example.com/role";

    await eventHandler(getElement("saveBtn"), "click")();

    expect(getElement("statusMsg").textContent).toMatch(/already exists/i);
    expect(getElement("statusMsg").textContent).not.toMatch(/updated/i);
  });
});

describe("sendMessageWithRetry", () => {
  it("returns the first response without injecting", async () => {
    const { api, executeScript, sendMessage } = loadPopup();
    const response = { description: "first response" };
    sendMessage.mockResolvedValueOnce(response);

    await expect(
      api.sendMessageWithRetry(7, { action: "extractJob" })
    ).resolves.toBe(response);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("injects once and retries once after the first send fails", async () => {
    const { api, executeScript, sendMessage } = loadPopup();
    const response = { description: "retry response" };
    const message = { action: "extractJob" };
    sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection."))
      .mockResolvedValueOnce(response);

    await expect(api.sendMessageWithRetry(7, message)).resolves.toBe(response);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content.js"],
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, 7, message);
  });

  it("rejects after one retry without looping", async () => {
    const { api, executeScript, sendMessage } = loadPopup();
    const message = { action: "extractJob" };
    sendMessage
      .mockRejectedValueOnce(new Error("Receiving end does not exist."))
      .mockRejectedValueOnce(new Error("retry failed"));

    await expect(api.sendMessageWithRetry(7, message)).rejects.toThrow(
      "retry failed"
    );

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, 7, message);
  });

  it("rethrows unrelated send errors without injecting or retrying", async () => {
    const { api, executeScript, sendMessage } = loadPopup();
    const error = new Error("The tab was closed.");
    sendMessage.mockRejectedValueOnce(error);

    await expect(
      api.sendMessageWithRetry(7, { action: "extractJob" })
    ).rejects.toBe(error);

    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("popup messaging flows", () => {
  it("uses retry messaging while extracting the page", async () => {
    const {
      api,
      executeScript,
      getElement,
      query,
      sendMessage,
    } = loadPopup();
    query.mockResolvedValueOnce([
      { id: 7, url: "https://jobs.example.com/role" },
    ]);
    sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection."))
      .mockResolvedValueOnce({
        jobTitle: "Software Engineer",
        company: "Example",
      });

    await api.extractFromPage();

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 7, {
      action: "extractJob",
    });
    expect(getElement("jobTitle").value).toBe("Software Engineer");
    expect(getElement("company").value).toBe("Example");
  });

  it("uses retry messaging to obtain a description for keyword analysis", async () => {
    const {
      api,
      executeScript,
      fetchMock,
      getElement,
      query,
      sendMessage,
    } = loadPopup();
    query.mockResolvedValueOnce([{ id: 7 }]);
    sendMessage
      .mockRejectedValueOnce(new Error("Receiving end does not exist."))
      .mockResolvedValueOnce({ description: "TypeScript and React" });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ totalJobKeywords: 0 }),
    });

    await api.runKeywordAnalysis();

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 7, {
      action: "extractJob",
    });
    expect(getElement("description").value).toBe("TypeScript and React");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/keyword-analysis",
      expect.objectContaining({
        body: JSON.stringify({ description: "TypeScript and React" }),
      })
    );
  });

  it("uses retry messaging while filling profile URLs", async () => {
    const {
      api,
      executeScript,
      fetchMock,
      getElement,
      query,
      sendMessage,
    } = loadPopup();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        linkedinUrl: "https://linkedin.com/in/example",
        githubUrl: "https://github.com/example",
      }),
    });
    query.mockResolvedValueOnce([{ id: 7 }]);
    sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection."))
      .mockResolvedValueOnce({ filled: ["LinkedIn", "GitHub"] });

    await api.fillProfiles();

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 7, {
      action: "autoFillProfiles",
      profiles: {
        linkedinUrl: "https://linkedin.com/in/example",
        githubUrl: "https://github.com/example",
      },
    });
    expect(getElement("statusMsg").textContent).toBe(
      "Auto-filled: LinkedIn, GitHub"
    );
  });
});
