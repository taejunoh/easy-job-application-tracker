import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createProtectedRoute } from "@/lib/security/protected-route";
import {
  applicationContractErrorResponse,
  parseUpdateApplicationRequest,
} from "@/lib/applications/contract";

const route = createProtectedRoute(["GET", "PATCH", "DELETE"]);

export const OPTIONS = route.OPTIONS;

export const GET = route.handler(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const application = await prisma.application.findUnique({ where: { id } });

  if (!application) {
    return NextResponse.json(
      { error: "Application not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(application);
});

export const PATCH = route.handler(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let input;
  try {
    input = await parseUpdateApplicationRequest(id, request);
  } catch (error) {
    const response = applicationContractErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const application = await prisma.application.update({
      where: { id },
      data: input.data,
    });
    return NextResponse.json(application);
  } catch (error) {
    if (!isApplicationNotFound(error)) {
      throw error;
    }
    return NextResponse.json(
      { error: "Application not found" },
      { status: 404 }
    );
  }
});

export const DELETE = route.handler(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await prisma.application.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (!isApplicationNotFound(error)) {
      throw error;
    }
    return NextResponse.json(
      { error: "Application not found" },
      { status: 404 }
    );
  }
});

function isApplicationNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}
