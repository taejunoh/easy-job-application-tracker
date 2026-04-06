import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface ExtractResult {
  jobTitle: string;
  company: string;
}

export interface LLMProvider {
  extract(text: string): Promise<ExtractResult>;
}

const PROMPT = `Extract the job title and company name from the following job posting text.
Return ONLY a JSON object with "jobTitle" and "company" fields. No other text.

Job posting text:
`;

function parseResponse(text: string): ExtractResult {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    jobTitle: parsed.jobTitle || "Unknown",
    company: parsed.company || "Unknown",
  };
}

class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async extract(text: string): Promise<ExtractResult> {
    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: PROMPT + text.slice(0, 4000) }],
      temperature: 0,
    });
    return parseResponse(response.choices[0].message.content || "{}");
  }
}

class GeminiProvider implements LLMProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async extract(text: string): Promise<ExtractResult> {
    const model = this.client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(PROMPT + text.slice(0, 4000));
    return parseResponse(result.response.text());
  }
}

class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(text: string): Promise<ExtractResult> {
    const response = await this.client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: PROMPT + text.slice(0, 4000) }],
    });
    const block = response.content[0];
    const responseText = block.type === "text" ? block.text : "{}";
    return parseResponse(responseText);
  }
}

export function createProvider(provider: string, apiKey: string): LLMProvider {
  switch (provider) {
    case "openai":
      return new OpenAIProvider(apiKey);
    case "gemini":
      return new GeminiProvider(apiKey);
    case "anthropic":
      return new AnthropicProvider(apiKey);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
