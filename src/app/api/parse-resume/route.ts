import { NextRequest, NextResponse } from "next/server";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createProtectedRoute } from "@/lib/security/protected-route";

// Point to the worker file for server-side usage
GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";

const route = createProtectedRoute(["POST"]);

export const OPTIONS = route.OPTIONS;

export const POST = route.handler(async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json(
      { error: "No file uploaded" },
      { status: 400 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();

  let text = "";

  if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
    const data = new Uint8Array(arrayBuffer);
    const doc = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
    const pages: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(pageText);
    }

    text = pages.join("\n");
    await doc.destroy();
  } else {
    text = Buffer.from(arrayBuffer).toString("utf-8");
  }

  return NextResponse.json({ text: text.trim() });
});
