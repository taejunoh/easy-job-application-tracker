import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const VALID_STATUSES = ["Applied", "Interview", "Offer", "Rejected"];
const VALID_JOB_TYPES = ["Remote", "Hybrid", "Onsite"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders });
}

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

    // Check if an application with a matching URL already exists (match by currentJobId param)
    let existing = null;
    const jobIdMatch = body.url.match(/currentJobId=(\d+)/);
    if (jobIdMatch) {
      const apps = await prisma.application.findMany({
        where: { url: { contains: `currentJobId=${jobIdMatch[1]}` } },
      });
      if (apps.length > 0) existing = apps[0];
    }

    if (existing) {
      // Update existing application with new data (fill in missing fields)
      const application = await prisma.application.update({
        where: { id: existing.id },
        data: {
          jobTitle: body.jobTitle || existing.jobTitle,
          company: body.company || existing.company,
          ...(body.description && { description: body.description }),
          ...(body.location && { location: body.location }),
          ...(body.jobType && { jobType: body.jobType }),
          ...(body.salary && { salary: body.salary }),
          ...(body.notes && !existing.notes ? { notes: body.notes } : {}),
        },
      });
      return NextResponse.json({ ...application, updated: true }, { status: 200, headers: corsHeaders });
    }

    const application = await prisma.application.create({
      data: {
        url: body.url,
        jobTitle: body.jobTitle,
        company: body.company,
        status: body.status || "Applied",
        appliedDate: body.appliedDate ? new Date(body.appliedDate) : new Date(),
        description: body.description || null,
        notes: body.notes || null,
        salary: body.salary || null,
        location: body.location || null,
        jobType: body.jobType || null,
      },
    });

    return NextResponse.json(application, { status: 201, headers: corsHeaders });
  } catch (error) {
    console.error("Create application error:", error);
    return NextResponse.json(
      { error: "Failed to create application" },
      { status: 500, headers: corsHeaders }
    );
  }
}
