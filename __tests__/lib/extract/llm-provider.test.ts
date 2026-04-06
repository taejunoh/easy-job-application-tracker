import { createProvider, LLMProvider } from "@/lib/extract/llm-provider";

describe("createProvider", () => {
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

  it("throws for unknown provider", () => {
    expect(() => createProvider("unknown", "key")).toThrow(
      "Unknown LLM provider: unknown"
    );
  });
});
