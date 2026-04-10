import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analyzeKeywordMatch } from "@/lib/keyword-matcher";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { description } = body;

  if (!description || !description.trim()) {
    return NextResponse.json(
      { error: "description is required" },
      { status: 400, headers: corsHeaders }
    );
  }

  const settings = await prisma.settings.findFirst();
  if (!settings?.resumeText) {
    return NextResponse.json(
      { error: "no_resume", message: "No resume text configured in settings" },
      { status: 200, headers: corsHeaders }
    );
  }

  const result = analyzeKeywordMatch(description, settings.resumeText);
  return NextResponse.json(result, { headers: corsHeaders });
}
