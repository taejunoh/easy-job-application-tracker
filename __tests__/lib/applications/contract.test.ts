import {
  APPLICATION_BODY_LIMIT_BYTES,
  parseCreateApplicationRequest,
  parseListApplicationsRequest,
  parseUpdateApplicationRequest,
} from "@/lib/applications/contract";

const VALID_CREATE = Object.freeze({
  url: "https://Jobs.Example.test:443/roles/1?job=1",
  jobTitle: " Engineer ",
  company: " Example ",
});

describe("Application request contract", () => {
  describe("POST", () => {
    it("normalizes the complete closed create object", async () => {
      const parsed = await parseCreateApplicationRequest(
        jsonRequest({
          ...VALID_CREATE,
          status: "Interview",
          appliedDate: "2026-08-13T09:10:11.123-04:00",
          description: "  description  ",
          notes: "   ",
          salary: null,
          location: " New York ",
          jobType: "Remote",
        }),
      );

      expect(parsed).toEqual({
        url: "https://Jobs.Example.test:443/roles/1?job=1",
        jobTitle: "Engineer",
        company: "Example",
        status: "Interview",
        appliedDate: new Date("2026-08-13T13:10:11.123Z"),
        description: "description",
        notes: null,
        salary: null,
        location: "New York",
        jobType: "Remote",
      });
      expect(Object.getPrototypeOf(parsed)).toBeNull();
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it("applies create defaults without manufacturing an applied date", async () => {
      await expect(parseCreateApplicationRequest(jsonRequest(VALID_CREATE))).resolves.toEqual({
        url: VALID_CREATE.url,
        jobTitle: "Engineer",
        company: "Example",
        status: "Applied",
        appliedDate: undefined,
        description: null,
        notes: null,
        salary: null,
        location: null,
        jobType: null,
      });
    });

    it.each([
      ["null", null],
      ["array", []],
      ["string", "application"],
      ["unknown key", { ...VALID_CREATE, id: "forbidden" }],
      ["blank URL", { ...VALID_CREATE, url: "  " }],
      ["blank title", { ...VALID_CREATE, jobTitle: "  " }],
      ["blank company", { ...VALID_CREATE, company: "  " }],
      ["non-string title", { ...VALID_CREATE, jobTitle: 7 }],
      ["invalid status", { ...VALID_CREATE, status: "Draft" }],
      ["invalid job type", { ...VALID_CREATE, jobType: "Office" }],
      ["non-string nullable field", { ...VALID_CREATE, notes: 7 }],
      ["URL credentials", { ...VALID_CREATE, url: "https://user:pass@example.test/job" }],
      ["URL fragment", { ...VALID_CREATE, url: "https://example.test/job#apply" }],
      ["non-HTTP URL", { ...VALID_CREATE, url: "ftp://example.test/job" }],
      ["URL control character", { ...VALID_CREATE, url: "https://example.test/\njob" }],
      ["date only", { ...VALID_CREATE, appliedDate: "2026-08-13" }],
      ["timezone-free date", { ...VALID_CREATE, appliedDate: "2026-08-13T09:10:11" }],
      ["impossible date", { ...VALID_CREATE, appliedDate: "2026-02-29T09:10:11Z" }],
      ["invalid offset", { ...VALID_CREATE, appliedDate: "2026-08-13T09:10:11+24:00" }],
      ["sub-millisecond date", { ...VALID_CREATE, appliedDate: "2026-08-13T09:10:11.1234Z" }],
    ])("rejects %s", async (_name, input) => {
      await expectInvalid(parseCreateApplicationRequest(jsonRequest(input)));
    });

    it.each([
      ["url", 2048, 2049],
      ["jobTitle", 256, 257],
      ["company", 256, 257],
      ["location", 512, 513],
      ["salary", 512, 513],
      ["notes", 20_000, 20_001],
      ["description", 100_000, 100_001],
    ] as const)("measures the %s limit in Unicode code points", async (field, accepted, rejected) => {
      const prefix = field === "url" ? "https://example.test/" : "";
      const unit = field === "description" ? "x" : "😀";
      const acceptedValue = prefix + unit.repeat(accepted - [...prefix].length);
      const rejectedValue = prefix + unit.repeat(rejected - [...prefix].length);

      await expect(
        parseCreateApplicationRequest(jsonRequest({ ...VALID_CREATE, [field]: acceptedValue })),
      ).resolves.toBeDefined();
      await expectInvalid(
        parseCreateApplicationRequest(jsonRequest({ ...VALID_CREATE, [field]: rejectedValue })),
      );
    });

    it("accepts exactly 256 KiB and rejects one additional byte", async () => {
      const accepted = exactSizeRequest(APPLICATION_BODY_LIMIT_BYTES);
      const rejected = exactSizeRequest(APPLICATION_BODY_LIMIT_BYTES + 1);

      await expect(parseCreateApplicationRequest(accepted)).rejects.toMatchObject({
        status: 400,
        code: "invalid_request",
      });
      await expect(parseCreateApplicationRequest(rejected)).rejects.toMatchObject({
        status: 413,
        code: "request_too_large",
      });
    });

    it("rejects a declared oversized body without reading its stream", async () => {
      const request = jsonRequest(VALID_CREATE, {
        "Content-Length": String(APPLICATION_BODY_LIMIT_BYTES + 1),
      });
      const readerSpy = jest.spyOn(request.body as ReadableStream, "getReader");

      await expect(parseCreateApplicationRequest(request)).rejects.toMatchObject({
        status: 413,
        code: "request_too_large",
      });
      expect(readerSpy).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    const id = "018f9f72-f2e9-7c29-a6fc-001122334455";

    it("normalizes only supplied mutable fields", async () => {
      const parsed = await parseUpdateApplicationRequest(
        id,
        jsonRequest({
          jobTitle: " Staff Engineer ",
          company: " Example ",
          status: "Offer",
          description: " ",
          notes: null,
          salary: " $200k ",
          location: " Remote ",
          jobType: "",
        }),
      );

      expect(parsed).toEqual({
        id,
        data: {
          jobTitle: "Staff Engineer",
          company: "Example",
          status: "Offer",
          description: null,
          notes: null,
          salary: "$200k",
          location: "Remote",
          jobType: null,
        },
      });
      expect(Object.getPrototypeOf(parsed)).toBeNull();
      expect(Object.getPrototypeOf(parsed.data)).toBeNull();
      expect(Object.isFrozen(parsed.data)).toBe(true);
    });

    it.each([
      ["invalid UUID", "app-1", { status: "Applied" }],
      ["empty body", id, {}],
      ["forbidden URL", id, { url: "https://example.test/other" }],
      ["forbidden ID", id, { id }],
      ["forbidden applied date", id, { appliedDate: "2026-08-13T00:00:00Z" }],
      ["blank title", id, { jobTitle: " " }],
      ["null company", id, { company: null }],
      ["invalid status", id, { status: "Pending" }],
      ["invalid job type", id, { jobType: "Anywhere" }],
    ])("rejects %s", async (_name, candidateId, body) => {
      await expectInvalid(parseUpdateApplicationRequest(candidateId, jsonRequest(body)));
    });
  });

  describe("GET", () => {
    it("normalizes allowlisted filters and defaults", () => {
      expect(
        parseListApplicationsRequest(
          new URL("https://app.test/api/applications?status=Applied&jobType=Hybrid&search=%20staff%20&sortBy=company&sortOrder=asc"),
        ),
      ).toEqual({
        status: "Applied",
        jobType: "Hybrid",
        search: "staff",
        sortBy: "company",
        sortOrder: "asc",
      });
      expect(parseListApplicationsRequest(new URL("https://app.test/api/applications"))).toEqual({
        status: undefined,
        jobType: undefined,
        search: undefined,
        sortBy: "appliedDate",
        sortOrder: "desc",
      });
    });

    it.each([
      "?unknown=value",
      "?status=Pending",
      "?status=",
      "?jobType=Office",
      "?search=",
      `?search=${"x".repeat(257)}`,
      "?sortBy=id",
      "?sortOrder=sideways",
      "?status=Applied&status=Offer",
    ])("rejects invalid query %s", (query) => {
      expect(() => parseListApplicationsRequest(new URL(`https://app.test/api/applications${query}`))).toThrow(
        expect.objectContaining({ status: 400, code: "invalid_request" }),
      );
    });
  });

  it("maps malformed JSON to the closed invalid-request error", async () => {
    await expect(parseCreateApplicationRequest(rawRequest("{"))).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        code: "invalid_request",
      }),
    );
  });
});

function jsonRequest(body: unknown, headers?: HeadersInit): Request {
  return rawRequest(JSON.stringify(body), headers);
}

function rawRequest(body: string, headers?: HeadersInit): Request {
  return new Request("https://app.test/api/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function exactSizeRequest(bytes: number): Request {
  const prefix = '{"padding":"';
  const suffix = '"}';
  return rawRequest(prefix + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix);
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
  });
}
