import { NextRequest, NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json(
      { error: "No file uploaded" },
      { status: 400, headers: corsHeaders }
    );
  }

  const arrayBuffer = await file.arrayBuffer();

  let text = "";

  if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
    const result = await parser.getText();
    text = result.text;
    await parser.destroy();
  } else {
    text = Buffer.from(arrayBuffer).toString("utf-8");
  }

  return NextResponse.json({ text: text.trim() }, { headers: corsHeaders });
}
