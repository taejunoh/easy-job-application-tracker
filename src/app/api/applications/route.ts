import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const VALID_STATUSES = ["Applied", "Interview", "Offer", "Rejected"];
const VALID_JOB_TYPES = ["Remote", "Hybrid", "Onsite"];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const jobType = searchParams.get("jobType");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "appliedDate";
  const sortOrder = searchParams.get("sortOrder") || "desc";

  const where: Record<string, unknown> = {};
  if (status && VALID_STATUSES.includes(status)) where.status = status;
  if (jobType && VALID_JOB_TYPES.includes(jobType)) where.jobType = jobType;
  if (search) {
    where.OR = [
      { jobTitle: { contains: search } },
      { company: { contains: search } },
    ];
  }

  const applications = await prisma.application.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
  });

  return NextResponse.json(applications);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.url || !body.jobTitle || !body.company) {
      return NextResponse.json(
        { error: "url, jobTitle, and company are required" },
        { status: 400 }
      );
    }

    const application = await prisma.application.create({
      data: {
        url: body.url,
        jobTitle: body.jobTitle,
        company: body.company,
        status: body.status || "Applied",
        appliedDate: body.appliedDate ? new Date(body.appliedDate) : new Date(),
        notes: body.notes || null,
        salary: body.salary || null,
        location: body.location || null,
        jobType: body.jobType || null,
      },
    });

    return NextResponse.json(application, { status: 201 });
  } catch (error) {
    console.error("Create application error:", error);
    return NextResponse.json(
      { error: "Failed to create application" },
      { status: 500 }
    );
  }
}
