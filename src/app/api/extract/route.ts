import { NextRequest, NextResponse } from "next/server";
import { parseMetaTags } from "@/lib/extract/meta-parser";
import { createProvider } from "@/lib/extract/llm-provider";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
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
        { status: 422 }
      );
    }

    const html = await response.text();

    // Step 1: Try meta tag parsing
    const metaResult = parseMetaTags(html);

    // Step 2: If both fields found, return immediately
    if (metaResult.jobTitle && metaResult.company) {
      return NextResponse.json({
        jobTitle: metaResult.jobTitle,
        company: metaResult.company,
        url,
      });
    }

    // Step 3: LLM fallback
    const settings = await prisma.settings.findFirst();
    if (!settings || !settings.apiKey) {
      // Return what we have without LLM
      return NextResponse.json({
        jobTitle: metaResult.jobTitle || "",
        company: metaResult.company || "",
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
      url,
    });
  } catch (error) {
    console.error("Extract error:", error);
    return NextResponse.json(
      { error: "Failed to extract job data" },
      { status: 500 }
    );
  }
}
