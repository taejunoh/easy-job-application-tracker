import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const popupScript = readFileSync(
  join(process.cwd(), "extension/popup.js"),
  "utf8"
);

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
}

interface PopupApi {
  sendMessageWithRetry(
    tabId: number,
    message: Record<string, unknown>
  ): Promise<unknown>;
  extractFromPage(): Promise<void>;
  runKeywordAnalysis(): Promise<void>;
  fillProfiles(): Promise<void>;
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
  };
}

function loadPopup() {
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
  const chrome = {
    tabs: {
      create: jest.fn(),
      query,
      sendMessage,
    },
    scripting: { executeScript },
    storage: {
      local: {
        get: jest.fn(),
        set: jest.fn(),
      },
    },
  };
  const commonJsModule: { exports: Partial<PopupApi> } = { exports: {} };
  const context = vm.createContext({
    chrome,
    console,
    document: {
      createElement: jest.fn(() => createElement()),
      getElementById: jest.fn((id: string) => getElement(id)),
    },
    exports: commonJsModule.exports,
    fetch: fetchMock,
    module: commonJsModule,
  });

  new vm.Script(popupScript).runInContext(context);

  return {
    api: commonJsModule.exports as PopupApi,
    chrome,
    elements,
    executeScript,
    fetchMock,
    getElement,
    query,
    sendMessage,
  };
}

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
