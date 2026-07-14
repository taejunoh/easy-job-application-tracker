import { createProvider } from "@/lib/extract/llm-provider";

const mockAnthropicCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

describe("createProvider", () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
  });

  it("creates an openai provider", () => {
    const provider = createProvider("openai", "test-key");
    expect(provider).toBeDefined();
    expect(provider.extract).toBeDefined();
  });

  it("creates a gemini provider", () => {
    const provider = createProvider("gemini", "test-key");
    expect(provider).toBeDefined();
    expect(provider.extract).toBeDefined();
  });

  it("creates an anthropic provider", () => {
    const provider = createProvider("anthropic", "test-key");
    expect(provider).toBeDefined();
    expect(provider.extract).toBeDefined();
  });

  it("sends the supported Anthropic messages payload and parses its text block", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"jobTitle":"Staff Engineer","company":"Acme"}',
        },
      ],
    });
    const provider = createProvider("anthropic", "test-key");
    const posting = `role:${"x".repeat(4_100)}`;

    await expect(provider.extract(posting)).resolves.toEqual({
      jobTitle: "Staff Engineer",
      company: "Acme",
    });
    expect(mockAnthropicCreate).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: expect.stringMatching(/Job posting text:\nrole:x{3995}$/u),
        },
      ],
    });
  });

  it("rejects an Anthropic response without a text block", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "extract",
          input: {},
        },
      ],
    });
    const provider = createProvider("anthropic", "test-key");

    await expect(provider.extract("posting")).rejects.toThrow(
      "Anthropic response did not contain a text block",
    );
  });

  it("propagates Anthropic API errors", async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error("rate limited"));
    const provider = createProvider("anthropic", "test-key");

    await expect(provider.extract("posting")).rejects.toThrow("rate limited");
  });

  it("throws for unknown provider", () => {
    expect(() => createProvider("unknown", "key")).toThrow(
      "Unknown LLM provider: unknown"
    );
  });
});
