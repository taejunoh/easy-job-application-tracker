import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";

export async function GET() {
  let settings = await prisma.settings.findFirst();

  if (!settings) {
    settings = await prisma.settings.create({ data: {} });
  }

  return NextResponse.json({
    llmProvider: settings.llmProvider,
    hasApiKey: settings.apiKey !== "",
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();

  const data: Record<string, string> = {};
  if (body.llmProvider !== undefined) data.llmProvider = body.llmProvider;
  if (body.apiKey !== undefined) {
    data.apiKey = body.apiKey ? encrypt(body.apiKey) : "";
  }

  let settings = await prisma.settings.findFirst();

  if (!settings) {
    settings = await prisma.settings.create({
      data: { ...data, id: "singleton" },
    });
  } else {
    settings = await prisma.settings.update({
      where: { id: settings.id },
      data,
    });
  }

  return NextResponse.json({
    llmProvider: settings.llmProvider,
    hasApiKey: settings.apiKey !== "",
  });
}
