import type { LookupAddress } from "node:dns";

import {
  MAX_JOB_PAGE_BYTES,
  SafeFetchTransportError,
  createPinnedLookup,
  createSafeFetchJobUrl,
  validateJobUrl,
  type SafeFetchDependencies,
  type SafeFetchTransportRequest,
  type SafeFetchTransportResponse,
} from "@/lib/security/safe-fetch";

const encoder = new TextEncoder();
const PUBLIC_V4: LookupAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: LookupAddress = {
  address: "2606:2800:220:1:248:1893:25c8:1946",
  family: 6,
};

describe("validateJobUrl", () => {
  it.each([
    "http://example.com/jobs/1",
    "http://example.com:80/jobs/1",
    "https://example.com/jobs/1",
    "https://example.com:443/jobs/1",
    "https://8.8.8.8/jobs/1",
  ])("accepts canonical public HTTP(S) URL %s", (input) => {
    expect(validateJobUrl(input).href).toBe(new URL(input).href);
  });

  it.each([
    "not a URL",
    "ftp://example.com/jobs/1",
    "file:///etc/passwd",
    "data:text/html,hello",
    "https://user@example.com/jobs/1",
    "https://:secret@example.com/jobs/1",
    "https://example.com/jobs/1#details",
    "https://example.com/jobs/1#",
    "http://example.com:443/jobs/1",
    "https://example.com:80/jobs/1",
    "https://example.com:3000/jobs/1",
    "http://localhost/jobs/1",
    "http://localhost./jobs/1",
    "http://service.localhost/jobs/1",
    "http://127.0.0.1/jobs/1",
    "http://2130706433/jobs/1",
    "http://[::1]/jobs/1",
    "http://[::ffff:127.0.0.1]/jobs/1",
  ])("rejects disallowed URL %s", (input) => {
    expect(() => validateJobUrl(input)).toThrow(
      expect.objectContaining({ code: "url_not_allowed", status: 422 }),
    );
  });
});

describe("createPinnedLookup", () => {
  it("returns only the captured, validated addresses", async () => {
    const lookup = createPinnedLookup("example.com", [PUBLIC_V4, PUBLIC_V6]);

    await expect(runLookup(lookup, "example.com", true)).resolves.toEqual([
      PUBLIC_V4,
      PUBLIC_V6,
    ]);
    await expect(runLookup(lookup, "example.com", false)).resolves.toEqual(
      PUBLIC_V4,
    );
  });

  it("fails closed for a hostname other than the validated hostname", async () => {
    const lookup = createPinnedLookup("example.com", [PUBLIC_V4]);

    await expect(runLookup(lookup, "attacker.example", true)).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });
});

describe("createSafeFetchJobUrl", () => {
  let resolve: jest.MockedFunction<SafeFetchDependencies["resolve"]>;
  let transport: jest.MockedFunction<SafeFetchDependencies["transport"]>;

  beforeEach(() => {
    resolve = jest.fn().mockResolvedValue([PUBLIC_V4]);
    transport = jest
      .fn()
      .mockResolvedValue(htmlResponse("<html><title>Engineer</title></html>"));
  });

  it("validates every DNS answer and pins the captured set into the connector lookup", async () => {
    resolve.mockResolvedValue([PUBLIC_V4, PUBLIC_V6]);
    let connectedAddresses: LookupAddress[] | undefined;
    transport.mockImplementation(async (request) => {
      connectedAddresses = (await runLookup(
        request.lookup,
        request.url.hostname,
        true,
      )) as LookupAddress[];
      return htmlResponse("<html>safe</html>");
    });

    const result = await fetcher({ resolve, transport })(
      "https://example.com/jobs/1",
    );

    expect(result).toEqual({
      html: "<html>safe</html>",
      finalUrl: "https://example.com/jobs/1",
    });
    expect(resolve).toHaveBeenCalledWith("example.com");
    expect(connectedAddresses).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it("rejects a mixed public and private DNS answer before transport", async () => {
    resolve.mockResolvedValue([
      PUBLIC_V4,
      { address: "10.0.0.7", family: 4 },
    ]);

    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toMatchObject({ code: "url_not_allowed", status: 422 });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{ address: "not-an-ip", family: 4 }]],
    [[{ address: "8.8.8.8", family: 6 }]],
  ] as [LookupAddress[]][])("rejects unusable DNS result %j", async (answers) => {
    resolve.mockResolvedValue(answers);

    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toMatchObject({ code: "url_not_allowed", status: 422 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not resolve an already validated public IP literal", async () => {
    await fetcher({ resolve, transport })("https://8.8.8.8/jobs/1");

    expect(resolve).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never forwards cookies, authorization, or other credentials across hops", async () => {
    transport
      .mockResolvedValueOnce(redirectResponse(302, "/final"))
      .mockResolvedValueOnce(htmlResponse("<html>safe</html>"));

    await fetcher({ resolve, transport })("https://example.com/start");

    for (const [request] of transport.mock.calls) {
      expect(Object.fromEntries(request.headers.entries())).toEqual({
        accept: "text/html, application/xhtml+xml",
        "user-agent": "JobTracker/1.0 (+server-side job extraction)",
      });
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
    }
  });

  it("revalidates DNS and policy for every relative redirect hop", async () => {
    resolve.mockImplementation(async (hostname) => {
      if (hostname === "example.com") return [PUBLIC_V4];
      if (hostname === "careers.example.net") return [PUBLIC_V6];
      throw new Error("unexpected hostname");
    });
    transport
      .mockResolvedValueOnce(
        redirectResponse(302, "https://careers.example.net/roles/1"),
      )
      .mockResolvedValueOnce(redirectResponse(301, "../jobs/1"))
      .mockResolvedValueOnce(htmlResponse("<html>final</html>"));

    const result = await fetcher({ resolve, transport })(
      "https://example.com/start",
    );

    expect(result).toEqual({
      html: "<html>final</html>",
      finalUrl: "https://careers.example.net/jobs/1",
    });
    expect(resolve.mock.calls).toEqual([
      ["example.com"],
      ["careers.example.net"],
      ["careers.example.net"],
    ]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("rejects a redirect whose DNS changes to a private address", async () => {
    resolve
      .mockResolvedValueOnce([PUBLIC_V4])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    transport.mockResolvedValueOnce(
      redirectResponse(302, "https://metadata.example/latest"),
    );

    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toMatchObject({ code: "url_not_allowed", status: 422 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("follows at most three redirects", async () => {
    let callIndex = 0;
    transport.mockImplementation(async () => {
      callIndex += 1;
      return redirectResponse(302, `/hop-${callIndex}`);
    });

    await expect(
      fetcher({ resolve, transport })("https://example.com/start"),
    ).rejects.toMatchObject({ code: "url_not_allowed", status: 422 });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it.each([
    [302, null],
    [302, "http://example.com:443/not-canonical"],
    [302, "https://example.com/path#fragment"],
  ])("rejects invalid redirect location for %s", async (status, location) => {
    transport.mockResolvedValue(
      response({ status, headers: location ? { Location: location } : {} }),
    );

    await expect(
      fetcher({ resolve, transport })("https://example.com/start"),
    ).rejects.toMatchObject({ code: "url_not_allowed", status: 422 });
  });

  it.each(["text/html", "text/html; charset=utf-8", "application/xhtml+xml"])(
    "accepts supported media type %s",
    async (contentType) => {
      transport.mockResolvedValue(
        response({
          headers: { "Content-Type": contentType },
          chunks: [encoder.encode("<html>ok</html>")],
        }),
      );

      await expect(
        fetcher({ resolve, transport })("https://example.com/jobs/1"),
      ).resolves.toMatchObject({ html: "<html>ok</html>" });
    },
  );

  it.each([null, "text/plain", "application/json"])(
    "rejects unsupported media type %s",
    async (contentType) => {
      transport.mockResolvedValue(
        response({
          headers: contentType ? { "Content-Type": contentType } : {},
          chunks: [encoder.encode("not html")],
        }),
      );

      await expect(
        fetcher({ resolve, transport })("https://example.com/jobs/1"),
      ).rejects.toMatchObject({
        code: "unsupported_upstream_type",
        status: 415,
      });
    },
  );

  it("allows exactly 2 MiB of decoded response body", async () => {
    transport.mockResolvedValue(
      response({
        headers: { "Content-Type": "text/html" },
        chunks: [new Uint8Array(MAX_JOB_PAGE_BYTES).fill(97)],
      }),
    );

    const result = await fetcher({ resolve, transport })(
      "https://example.com/jobs/1",
    );

    expect(result.html).toHaveLength(MAX_JOB_PAGE_BYTES);
  });

  it("rejects more than 2 MiB of decoded body even when declared smaller", async () => {
    transport.mockResolvedValue(
      response({
        headers: {
          "Content-Type": "text/html",
          "Content-Length": "1",
          "Content-Encoding": "gzip",
        },
        chunks: [
          new Uint8Array(MAX_JOB_PAGE_BYTES).fill(97),
          new Uint8Array([97]),
        ],
      }),
    );

    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toMatchObject({ code: "upstream_too_large", status: 413 });
  });

  it("maps a non-success response without exposing its body", async () => {
    transport.mockResolvedValue(
      response({
        status: 404,
        headers: { "Content-Type": "text/html" },
        chunks: [encoder.encode("internal upstream detail")],
      }),
    );

    await expect(
      fetcher({ resolve, transport })("https://example.com/missing"),
    ).rejects.toMatchObject({ code: "upstream_failed", status: 422 });
  });

  it("maps a response-stream network failure to upstream_failed", async () => {
    transport.mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "text/html" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("socket reset detail"));
        },
      }),
      dispose: jest.fn().mockResolvedValue(undefined),
    });

    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toMatchObject({ code: "upstream_failed", status: 422 });
  });

  it.each([
    ["network", "upstream_failed", 422],
    ["timeout", "upstream_timeout", 504],
  ] as const)(
    "maps normalized %s transport failures",
    async (kind, code, status) => {
      transport.mockRejectedValueOnce(new SafeFetchTransportError(kind));
      await expect(
        fetcher({ resolve, transport })("https://example.com/jobs/1"),
      ).rejects.toMatchObject({ code, status });
    },
  );

  it("preserves unexpected transport errors for the internal 500 boundary", async () => {
    transport.mockRejectedValueOnce(new Error("programmer failure"));
    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toThrow("programmer failure");
  });

  describe("deadlines", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("times out DNS under the 10 second hop budget", async () => {
      resolve.mockReturnValue(new Promise(() => undefined));
      const promise = fetcher({ resolve, transport })(
        "https://example.com/jobs/1",
      );
      const expectation = expect(promise).rejects.toMatchObject({
        code: "upstream_timeout",
        status: 504,
      });

      await jest.advanceTimersByTimeAsync(10_000);

      await expectation;
      expect(transport).not.toHaveBeenCalled();
    });

    it("times out connection or headers under the same 10 second hop budget", async () => {
      transport.mockReturnValue(new Promise(() => undefined));
      const promise = fetcher({ resolve, transport })(
        "https://example.com/jobs/1",
      );
      const expectation = expect(promise).rejects.toMatchObject({
        code: "upstream_timeout",
        status: 504,
      });

      await jest.advanceTimersByTimeAsync(10_000);

      await expectation;
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("keeps the 10 second hop budget active while streaming the body", async () => {
      transport.mockResolvedValue({
        status: 200,
        headers: new Headers({ "Content-Type": "text/html" }),
        body: new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => undefined),
        }),
        dispose: jest.fn().mockResolvedValue(undefined),
      });
      const promise = fetcher({ resolve, transport })(
        "https://example.com/jobs/1",
      );
      const expectation = expect(promise).rejects.toMatchObject({
        code: "upstream_timeout",
        status: 504,
      });

      await jest.advanceTimersByTimeAsync(10_000);

      await expectation;
    });

    it("caps the complete redirect chain at 20 seconds", async () => {
      transport.mockImplementation(
        () =>
          new Promise((resolveResponse) => {
            setTimeout(
              () => resolveResponse(redirectResponse(302, "/next")),
              8_000,
            );
          }),
      );
      const promise = fetcher({ resolve, transport })(
        "https://example.com/start",
      );
      const expectation = expect(promise).rejects.toMatchObject({
        code: "upstream_timeout",
        status: 504,
      });

      await jest.advanceTimersByTimeAsync(20_000);

      await expectation;
      expect(transport).toHaveBeenCalledTimes(3);
    });
  });
});

function fetcher(
  dependencies: Pick<SafeFetchDependencies, "resolve" | "transport">,
) {
  return createSafeFetchJobUrl({
    ...dependencies,
    now: () => Date.now(),
    setTimeout,
    clearTimeout,
  });
}

function htmlResponse(html: string): SafeFetchTransportResponse {
  return response({
    headers: { "Content-Type": "text/html; charset=utf-8" },
    chunks: [encoder.encode(html)],
  });
}

function redirectResponse(
  status: number,
  location: string,
): SafeFetchTransportResponse {
  return response({ status, headers: { Location: location } });
}

function response({
  status = 200,
  headers = {},
  chunks = [],
}: {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
}): SafeFetchTransportResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    dispose: jest.fn().mockResolvedValue(undefined),
  };
}

function runLookup(
  lookup: SafeFetchTransportRequest["lookup"],
  hostname: string,
  all: boolean,
): Promise<string | LookupAddress | LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof address === "string") {
        resolve({ address, family: family as 4 | 6 });
        return;
      }
      resolve(address);
    });
  });
}
