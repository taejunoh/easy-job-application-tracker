import { connectWithAccessToken } from "@/app/connect/page";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), refresh: jest.fn() }),
}));

describe("connectWithAccessToken", () => {
  it("posts the token only in same-origin JSON without client persistence", async () => {
    const response = Response.json({ authenticated: true });
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response);
    const token = "secret-access-token";

    const result = await connectWithAccessToken(token);

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(fetchMock.mock.calls[0][0]).not.toContain(token);
    fetchMock.mockRestore();
  });
});
