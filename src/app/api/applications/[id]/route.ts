import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
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
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  try {
    const application = await prisma.application.update({
      where: { id },
      data: {
        ...(body.jobTitle !== undefined && { jobTitle: body.jobTitle }),
        ...(body.company !== undefined && { company: body.company }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.notes !== undefined && { notes: body.notes || null }),
        ...(body.salary !== undefined && { salary: body.salary || null }),
        ...(body.location !== undefined && { location: body.location || null }),
        ...(body.jobType !== undefined && { jobType: body.jobType || null }),
      },
    });
    return NextResponse.json(application);
  } catch {
    return NextResponse.json(
      { error: "Application not found" },
      { status: 404 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await prisma.application.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Application not found" },
      { status: 404 }
    );
  }
}
