import {
  MAX_MULTIPART_BYTES,
  MAX_RESUME_BYTES,
  ResumeUploadError,
  readResumeUpload,
} from "@/lib/resume/upload-policy";

describe("bounded resume multipart uploads", () => {
  it("accepts exactly one resume file at the 5 MiB file boundary", async () => {
    const bytes = new Uint8Array(MAX_RESUME_BYTES);
    bytes.set(Buffer.from("%PDF-"));

    await expect(readResumeUpload(multipartRequest(bytes))).resolves.toEqual({
      filename: "resume.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from(bytes),
    });
  });

  it("rejects a file one byte above 5 MiB and cancels the request reader", async () => {
    const source = multipartRequest(
      new Uint8Array(MAX_RESUME_BYTES + 1),
    );
    const cancel = jest.fn();
    const request = instrumentCancellation(source, cancel);

    await expect(readResumeUpload(request)).rejects.toMatchObject({
      name: "ResumeUploadError",
      code: "upload_too_large",
      status: 413,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a declared envelope above 6 MiB before reading the body", async () => {
    const request = multipartRequest(Buffer.from("%PDF-small"), {
      "Content-Length": String(MAX_MULTIPART_BYTES + 1),
    });
    const getReader = jest.spyOn(request.body as ReadableStream, "getReader");

    await expect(readResumeUpload(request)).rejects.toMatchObject({
      code: "upload_too_large",
      status: 413,
    });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("enforces the 6 MiB envelope against the actual stream", async () => {
    const source = streamingRequest(MAX_MULTIPART_BYTES + 1);

    await expect(readResumeUpload(source.request)).rejects.toMatchObject({
      code: "upload_too_large",
      status: 413,
    });
    expect(source.readerCancel).toHaveBeenCalled();
  });

  it.each([
    ["a non-multipart request", new Request("https://example.test", { method: "POST", body: "x" })],
    [
      "multipart without a boundary",
      new Request("https://example.test", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data" },
        body: "x",
      }),
    ],
  ])("rejects %s as malformed", async (_name, request) => {
    await expect(readResumeUpload(request)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  it.each([
    ["the wrong field name", formWithFiles([["file", "%PDF-a", "a.pdf", "application/pdf"]])],
    [
      "two resume files",
      formWithFiles([
        ["resume", "%PDF-a", "a.pdf", "application/pdf"],
        ["resume", "%PDF-b", "b.pdf", "application/pdf"],
      ]),
    ],
    ["a text field", formWithTextField()],
    ["no parts", new FormData()],
  ])("requires exactly one resume file and rejects %s", async (_name, form) => {
    await expect(readResumeUpload(formRequest(form))).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  it("exposes only stable error metadata", () => {
    expect(new ResumeUploadError("invalid_request")).toMatchObject({
      name: "ResumeUploadError",
      code: "invalid_request",
      status: 400,
    });
  });
});

function multipartRequest(
  bytes: BlobPart,
  headers?: HeadersInit,
): Request {
  const form = new FormData();
  form.set("resume", new File([bytes], "resume.pdf", { type: "application/pdf" }));
  return formRequest(form, headers);
}

function formRequest(form: FormData, headers?: HeadersInit): Request {
  return new Request("https://example.test/api/parse-resume", {
    method: "POST",
    headers,
    body: form,
  });
}

function formWithFiles(
  files: Array<[string, string, string, string]>,
): FormData {
  const form = new FormData();
  for (const [field, value, filename, type] of files) {
    form.append(field, new File([value], filename, { type }));
  }
  return form;
}

function formWithTextField(): FormData {
  const form = new FormData();
  form.set("note", "not allowed");
  return form;
}

function streamingRequest(byteLength: number): {
  request: Request;
  readerCancel: jest.Mock;
} {
  const readerCancel = jest.fn();
  const chunk = new Uint8Array(64 * 1024);
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const remaining = byteLength - emitted;
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const value = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
      emitted += value.byteLength;
      controller.enqueue(value);
    },
  });
  const getReader = body.getReader.bind(body);
  jest.spyOn(body, "getReader").mockImplementation(() => {
    const reader = getReader();
    const cancel = reader.cancel.bind(reader);
    jest.spyOn(reader, "cancel").mockImplementation((reason) => {
      readerCancel(reason);
      return cancel(reason);
    });
    return reader;
  });
  return {
    request: new Request("https://example.test/api/parse-resume", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    readerCancel,
  };
}

function instrumentCancellation(source: Request, cancel: jest.Mock): Request {
  const reader = (source.body as ReadableStream<Uint8Array>).getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel(reason) {
      cancel(reason);
      await reader.cancel(reason);
    },
  });
  return new Request(source.url, {
    method: "POST",
    headers: source.headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
