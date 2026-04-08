import { NextRequest, NextResponse } from "next/server";
import { parseMetaTags } from "@/lib/extract/meta-parser";
import { createProvider } from "@/lib/extract/llm-provider";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, text } = body;

    // Mode 1: Text paste — send directly to LLM
    if (text && typeof text === "string" && text.trim()) {
      const settings = await prisma.settings.findFirst();
      if (!settings || !settings.apiKey) {
        return NextResponse.json(
          { error: "No LLM provider configured. Go to Settings to add an API key." },
          { status: 400, headers: corsHeaders() }
        );
      }

      const apiKey = decrypt(settings.apiKey);
      const provider = createProvider(settings.llmProvider, apiKey);
      const llmResult = await provider.extract(text.slice(0, 8000));

      return NextResponse.json({
        jobTitle: llmResult.jobTitle,
        company: llmResult.company,
        url: url || "",
      }, { headers: corsHeaders() });
    }

    // Mode 2: URL extraction
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL or text is required" }, { status: 400, headers: corsHeaders() });
    }

    // Fetch the page
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobTracker/1.0)",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch URL" },
        { status: 422, headers: corsHeaders() }
      );
    }

    const html = await response.text();

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
      }, { headers: corsHeaders() });
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
      }, { headers: corsHeaders() });
    }

    // Step 3: LLM fallback
    const settings = await prisma.settings.findFirst();
    if (!settings || !settings.apiKey) {
      return NextResponse.json({
        jobTitle: metaResult.jobTitle || "",
        company: metaResult.company || "",
        location: metaResult.location || "",
        url,
      }, { headers: corsHeaders() });
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
    }, { headers: corsHeaders() });
  } catch (error) {
    console.error("Extract error:", error);
    return NextResponse.json(
      { error: "Failed to extract job data" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
