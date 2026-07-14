import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { gzipSync } from "node:zlib";
import {
  Response as UndiciResponse,
  errors as undiciErrors,
  fetch as undiciFetch,
} from "undici";

import {
  MAX_JOB_PAGE_BYTES,
  SafeFetchTransportError,
  createPinnedConnector,
  createPinnedLookup,
  createSafeFetchJobUrl,
  createUndiciTransport,
  monotonicNow,
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
const NODE_X509_VERIFY_CODES = [
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
] as const;
const REMOTE_TLS_ERROR_CODES = [
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_UNSUPPORTED_PROTOCOL",
  "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_SSLV3_ALERT_DECOMPRESSION_FAILURE",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_SSLV3_ALERT_ILLEGAL_PARAMETER",
  "ERR_SSL_SSLV3_ALERT_NO_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_UNEXPECTED_MESSAGE",
  "ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV13_ALERT_MISSING_EXTENSION",
  "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED",
  "ERR_SSL_TLSV1_ALERT_DECODE_ERROR",
  "ERR_SSL_TLSV1_ALERT_DECRYPTION_FAILED",
  "ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR",
  "ERR_SSL_TLSV1_ALERT_EXPORT_RESTRICTION",
  "ERR_SSL_TLSV1_ALERT_INAPPROPRIATE_FALLBACK",
  "ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY",
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL",
  "ERR_SSL_TLSV1_ALERT_NO_RENEGOTIATION",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_TLSV1_ALERT_RECORD_OVERFLOW",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY",
  "ERR_SSL_TLSV1_ALERT_USER_CANCELLED",
] as const;

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

describe("createPinnedConnector", () => {
  it("pins connector hostname and explicitly preserves the TLS servername", () => {
    const lookup = createPinnedLookup("example.com", [PUBLIC_V4]);
    const innerConnector = jest.fn();
    const connectorBuilder = jest.fn(() => innerConnector);
    const connector = createPinnedConnector(
      "example.com",
      lookup,
      10_000,
      connectorBuilder as never,
    );
    const callback = jest.fn();
    const options = {
      hostname: "example.com",
      host: "example.com:443",
      protocol: "https:",
      port: "443",
    };

    connector(options, callback);

    expect(connectorBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ lookup, timeout: 10_000, maxCachedSessions: 0 }),
    );
    expect(innerConnector).toHaveBeenCalledWith(
      { ...options, servername: "example.com" },
      callback,
    );
  });

  it("fails closed before the socket connector can switch hostnames", () => {
    const innerConnector = jest.fn();
    const connector = createPinnedConnector(
      "example.com",
      createPinnedLookup("example.com", [PUBLIC_V4]),
      10_000,
      jest.fn(() => innerConnector) as never,
    );
    const callback = jest.fn();

    connector(
      {
        hostname: "attacker.example",
        host: "attacker.example:443",
        protocol: "https:",
        port: "443",
      },
      callback,
    );

    expect(innerConnector).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.any(Error), null);
  });
});

describe("createUndiciTransport", () => {
  it("passes the original URL host to fetch while pinning only socket lookup", async () => {
    const fetchImplementation = jest.fn().mockResolvedValue(
      new UndiciResponse("<html>ok</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const transport = createUndiciTransport(fetchImplementation as never);
    const request = transportRequest();

    const response = await transport(request);

    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "example.com",
        host: "example.com",
      }),
      expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }),
    );
    await response.body?.cancel();
    await response.dispose();
  });

  it("normalizes an aborted request as a timeout without leaking its cause", async () => {
    const controller = new AbortController();
    controller.abort();
    const detail = new Error("internal abort detail");
    const transport = createUndiciTransport(
      jest.fn().mockRejectedValue(detail) as never,
    );

    await expect(transport(transportRequest(controller.signal))).rejects.toEqual(
      expect.objectContaining({
        name: "SafeFetchTransportError",
        kind: "timeout",
        message: "Upstream transport timed out",
      }),
    );
  });

  it("maps a real plaintext response on an HTTPS socket to a network failure", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });
    await listenOnLoopback(server);
    const { port } = server.address() as AddressInfo;
    const transport = createUndiciTransport(undiciFetch);

    try {
      await expect(
        settleWithin(
          transport({
            ...transportRequest(),
            url: new URL(`https://plaintext.test:${port}/`),
            lookup: createPinnedLookup("plaintext.test", [
              { address: "127.0.0.1", family: 4 },
            ]),
            timeoutMs: 2_000,
          }),
          1_000,
        ),
      ).rejects.toMatchObject({
        name: "SafeFetchTransportError",
        kind: "network",
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  it("settles a stalled body and closes its dispatcher socket on deadline abort", async () => {
    const sockets = new Set<Socket>();
    let markSocketClosed: () => void = () => undefined;
    const socketClosed = new Promise<void>((resolve) => {
      markSocketClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.write("partial");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        markSocketClosed();
      });
    });
    await listenOnLoopback(server);

    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const transport = createUndiciTransport(undiciFetch);
    const response = await transport({
      ...transportRequest(controller.signal),
      url: new URL(`http://body-timeout.test:${port}/`),
      lookup: createPinnedLookup("body-timeout.test", [
        { address: "127.0.0.1", family: 4 },
      ]),
      timeoutMs: 2_000,
    });
    const reader = response.body?.getReader();

    try {
      expect(reader).toBeDefined();
      const firstChunk = await settleWithin(reader!.read(), 1_000);
      expect(firstChunk.done).toBe(false);
      expect(new TextDecoder().decode(firstChunk.value)).toBe("partial");

      const pendingRead = reader!.read().then(
        () => "resolved",
        () => "rejected",
      );
      controller.abort(new Error("body deadline exceeded"));

      await expect(settleWithin(pendingRead, 1_000)).resolves.toBe("rejected");
      await settleWithin(response.dispose(), 1_000);
      await expect(settleWithin(socketClosed, 1_000)).resolves.toBeUndefined();
    } finally {
      controller.abort();
      reader?.releaseLock();
      await response.dispose();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  it.each([
    [new undiciErrors.ConnectTimeoutError(), "timeout"],
    [new undiciErrors.HeadersTimeoutError(), "timeout"],
    [new undiciErrors.BodyTimeoutError(), "timeout"],
    [new undiciErrors.SocketError("socket reset detail"), "network"],
    [new undiciErrors.HeadersOverflowError("header overflow detail"), "network"],
    [
      new undiciErrors.ResponseContentLengthMismatchError(
        "response length mismatch detail",
      ),
      "network",
    ],
    [new undiciErrors.HTTPParserError("HTTP parser detail"), "network"],
    [
      Object.assign(new Error("HTTP parser code detail"), {
        code: "HPE_INVALID_HEADER_TOKEN",
      }),
      "network",
    ],
    [
      Object.assign(new Error("TLS certificate detail"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
      "network",
    ],
    [
      Object.assign(new Error("TLS certificate altname format detail"), {
        code: "ERR_TLS_CERT_ALTNAME_FORMAT",
      }),
      "network",
    ],
    [
      Object.assign(new Error("connection detail"), { code: "ECONNREFUSED" }),
      "network",
    ],
    [Object.assign(new Error("DNS detail"), { code: "ENOTFOUND" }), "network"],
    [
      Object.assign(new Error("TLS issuer detail"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      }),
      "network",
    ],
  ] as const)("normalizes known fetch cause %# as %s", async (cause, kind) => {
    const fetchError = new TypeError("fetch failed", { cause });
    const transport = createUndiciTransport(
      jest.fn().mockRejectedValue(fetchError) as never,
    );

    await expect(transport(transportRequest())).rejects.toMatchObject({
      name: "SafeFetchTransportError",
      kind,
    });
  });

  it.each(NODE_X509_VERIFY_CODES)(
    "normalizes Node X509 verification code %s as a network failure",
    async (code) => {
      const cause = Object.assign(new Error("certificate verification detail"), {
        code,
      });
      const transport = createUndiciTransport(
        jest
          .fn()
          .mockRejectedValue(new TypeError("fetch failed", { cause })) as never,
      );

      await expect(transport(transportRequest())).rejects.toMatchObject({
        name: "SafeFetchTransportError",
        kind: "network",
      });
    },
  );

  it.each(REMOTE_TLS_ERROR_CODES)(
    "normalizes exact remote TLS code %s as a network failure",
    async (code) => {
      const cause = Object.assign(new Error("remote TLS detail"), { code });
      const transport = createUndiciTransport(
        jest
          .fn()
          .mockRejectedValue(new TypeError("fetch failed", { cause })) as never,
      );

      await expect(transport(transportRequest())).rejects.toMatchObject({
        name: "SafeFetchTransportError",
        kind: "network",
      });
    },
  );

  it.each([
    new Error("programmer failure"),
    new TypeError("fetch failed"),
    new TypeError("fetch failed", {
      cause: new undiciErrors.InvalidArgumentError("invalid trusted option"),
    }),
    new TypeError("fetch failed", {
      cause: new undiciErrors.InvalidReturnValueError(
        "invalid trusted return value",
      ),
    }),
    Object.assign(new Error("invalid TLS configuration"), {
      code: "ERR_TLS_INVALID_PROTOCOL_VERSION",
    }),
    Object.assign(new Error("invalid local cipher configuration"), {
      code: "ERR_SSL_NO_CIPHER_MATCH",
    }),
    Object.assign(new Error("local OpenSSL allocation failure"), {
      code: "OUT_OF_MEM",
    }),
    Object.assign(new Error("unlisted SSL failure"), {
      code: "ERR_SSL_UNLISTED_FAILURE",
    }),
  ])("rethrows unexpected fetch exception %# for the route 500 boundary", async (error) => {
    const transport = createUndiciTransport(
      jest.fn().mockRejectedValue(error) as never,
    );

    await expect(transport(transportRequest())).rejects.toBe(error);
  });
});

describe("monotonicNow", () => {
  it("is unaffected when the wall clock rolls backward", () => {
    const wallClock = jest
      .spyOn(Date, "now")
      .mockReturnValueOnce(10_000)
      .mockReturnValue(0);

    try {
      const beforeRollback = monotonicNow();
      const afterRollback = monotonicNow();

      expect(afterRollback).toBeGreaterThanOrEqual(beforeRollback);
      expect(wallClock).not.toHaveBeenCalled();
    } finally {
      wallClock.mockRestore();
    }
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
    // This fake transport follows undici.fetch's contract: yielded chunks are
    // already decoded even though the response retains Content-Encoding.
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

  it("enforces the decoded limit on a real gzip response larger than its wire body", async () => {
    const decodedBody = Buffer.alloc(MAX_JOB_PAGE_BYTES + 1, 97);
    const wireBody = gzipSync(decodedBody);
    expect(wireBody.byteLength).toBeLessThan(MAX_JOB_PAGE_BYTES);

    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Encoding": "gzip",
        "Content-Length": String(wireBody.byteLength),
      });
      response.end(wireBody);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await listenOnLoopback(server);
    const { port } = server.address() as AddressInfo;
    let upstream: SafeFetchTransportResponse | undefined;

    try {
      upstream = await settleWithin(
        createUndiciTransport(undiciFetch)({
          ...transportRequest(),
          url: new URL(`http://gzip.test:${port}/`),
          lookup: createPinnedLookup("gzip.test", [
            { address: "127.0.0.1", family: 4 },
          ]),
          timeoutMs: 2_000,
        }),
        1_000,
      );
      expect(upstream.headers.get("content-length")).toBe(
        String(wireBody.byteLength),
      );
      transport.mockResolvedValue(upstream);

      await expect(
        fetcher({ resolve, transport })("https://example.com/jobs/1"),
      ).rejects.toMatchObject({ code: "upstream_too_large", status: 413 });
    } finally {
      await upstream?.dispose();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
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

  it.each([
    [new undiciErrors.SocketError("socket reset detail"), "upstream_failed", 422],
    [
      Object.assign(new Error("DNS detail"), { code: "ENOTFOUND" }),
      "upstream_failed",
      422,
    ],
    [
      Object.assign(new Error("TLS detail"), { code: "CERT_REVOKED" }),
      "upstream_failed",
      422,
    ],
    [new undiciErrors.BodyTimeoutError(), "upstream_timeout", 504],
  ] as const)(
    "maps known response-stream failure %# to %s",
    async (streamError, code, status) => {
      transport.mockResolvedValue(streamErrorResponse(streamError));

      await expect(
        fetcher({ resolve, transport })("https://example.com/jobs/1"),
      ).rejects.toMatchObject({ code, status });
    },
  );

  it.each([
    new Error("programmer stream failure"),
    new TypeError("unexpected decoder failure"),
    Object.assign(new Error("invalid local TLS state"), {
      code: "ERR_SSL_NO_CIPHER_MATCH",
    }),
  ])("preserves unexpected response-stream error %# for the 500 boundary", async (streamError) => {
    transport.mockResolvedValue(streamErrorResponse(streamError));

    await expect(
      fetcher({ resolve, transport })("https://example.com/jobs/1"),
    ).rejects.toBe(streamError);
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

function streamErrorResponse(error: Error): SafeFetchTransportResponse {
  return {
    status: 200,
    headers: new Headers({ "Content-Type": "text/html" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    }),
    dispose: jest.fn().mockResolvedValue(undefined),
  };
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

function transportRequest(
  signal = new AbortController().signal,
): SafeFetchTransportRequest {
  return {
    url: new URL("https://example.com/jobs/1"),
    lookup: createPinnedLookup("example.com", [PUBLIC_V4]),
    signal,
    timeoutMs: 10_000,
    headers: new Headers({
      Accept: "text/html, application/xhtml+xml",
      "User-Agent": "JobTracker/1.0 (+server-side job extraction)",
    }),
  };
}

function listenOnLoopback(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
