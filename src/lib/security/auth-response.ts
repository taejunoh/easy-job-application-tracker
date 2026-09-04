import "server-only";

export function privateNoStore(response: Response): Response {
  if (response.headers.get("Cache-Control") !== "private, no-store") {
    response.headers.set("Cache-Control", "no-store");
  }
  response.headers.set("Pragma", "no-cache");
  return response;
}
