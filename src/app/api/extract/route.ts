import { NextRequest, NextResponse } from "next/server";
import { parseMetaTags } from "@/lib/extract/meta-parser";
import { createProvider } from "@/lib/extract/llm-provider";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { createProtectedRoute } from "@/lib/security/protected-route";
import { readJsonBody } from "@/lib/security/request-body";
import {
  SafeFetchError,
  safeFetchJobUrl,
} from "@/lib/security/safe-fetch";

export const runtime = "nodejs";

const route = createProtectedRoute(["POST"]);

export const OPTIONS = route.OPTIONS;

export const POST = route.handler(async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  const { url, text } = body;

  // Mode 1: Text paste — send directly to LLM
  if (text && typeof text === "string" && text.trim()) {
    const settings = await prisma.settings.findFirst();
    if (!settings || !settings.apiKey) {
      return NextResponse.json(
        { error: "No LLM provider configured. Go to Settings to add an API key." },
        { status: 400 }
      );
    }

    const apiKey = decrypt(settings.apiKey);
    const provider = createProvider(settings.llmProvider, apiKey);
    const llmResult = await provider.extract(text.slice(0, 8000));

    return NextResponse.json({
      jobTitle: llmResult.jobTitle,
      company: llmResult.company,
      url: url || "",
    });
  }

  // Mode 2: URL extraction
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "URL or text is required" }, { status: 400 });
  }

  let html: string;
  try {
    ({ html } = await safeFetchJobUrl(url));
  } catch (error) {
    if (error instanceof SafeFetchError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }

  // Detect login/auth walls
  const loginPatterns = [
    /sign\s*in/i,
    /log\s*in/i,
    /authentication/i,
  ];
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].trim() : "";
  const isLoginWall = loginPatterns.some((p) => p.test(pageTitle)) &&
    !pageTitle.toLowerCase().includes("engineer") &&
    !pageTitle.toLowerCase().includes("manager") &&
    !pageTitle.toLowerCase().includes("developer") &&
    !pageTitle.toLowerCase().includes("analyst");

  if (isLoginWall) {
    return NextResponse.json({
      jobTitle: "",
      company: "",
      url,
      warning: "This site requires login. Try using the 'Paste Text' tab or the Chrome extension instead.",
    });
  }

  // Step 1: Try meta tag parsing
  const metaResult = parseMetaTags(html);

  // Step 2: If both fields found, return immediately
  if (metaResult.jobTitle && metaResult.company) {
    return NextResponse.json({
      jobTitle: metaResult.jobTitle,
      company: metaResult.company,
      location: metaResult.location || "",
      url,
    });
  }

  // Step 3: LLM fallback
  const settings = await prisma.settings.findFirst();
  if (!settings || !settings.apiKey) {
    return NextResponse.json({
      jobTitle: metaResult.jobTitle || "",
      company: metaResult.company || "",
      location: metaResult.location || "",
      url,
    });
  }

  const apiKey = decrypt(settings.apiKey);
  const provider = createProvider(settings.llmProvider, apiKey);

  // Strip HTML to plain text for LLM
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const llmResult = await provider.extract(textContent);

  return NextResponse.json({
    jobTitle: metaResult.jobTitle || llmResult.jobTitle,
    company: metaResult.company || llmResult.company,
    location: metaResult.location || "",
    url,
  });
});
