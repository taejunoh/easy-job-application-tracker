import "server-only";

export const MAX_LOGIN_BODY_BYTES = 4_096;
export const MAX_SETTINGS_BODY_BYTES = 6 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidRequestError extends Error {
  constructor() {
    super("Request body could not be parsed");
    this.name = "InvalidRequestError";
  }
}

export async function readJsonBody(
  request: Request,
): Promise<Awaited<ReturnType<Request["json"]>>> {
  try {
    return await request.json();
  } catch {
    throw new InvalidRequestError();
  }
}

export async function readFormDataBody(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new InvalidRequestError();
  }
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MAX_LOGIN_BODY_BYTES,
): Promise<unknown> {
  rejectDeclaredOversize(request.headers.get("content-length"), maxBytes);

  if (request.body === null) {
    return JSON.parse("") as unknown;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function rejectDeclaredOversize(
  contentLength: string | null,
  maxBytes: number,
): void {
  if (/^(?:0|[1-9][0-9]*)$/u.test(contentLength ?? "")) {
    if (BigInt(contentLength as string) > BigInt(maxBytes)) {
      throw new RequestBodyTooLargeError();
    }
  }
}
