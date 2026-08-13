import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createProtectedRoute } from "@/lib/security/protected-route";
import {
  applicationContractErrorResponse,
  parseCreateApplicationRequest,
  parseListApplicationsRequest,
} from "@/lib/applications/contract";

const route = createProtectedRoute(["GET", "POST"]);

export const OPTIONS = route.OPTIONS;

export const GET = route.handler(async function GET(request: NextRequest) {
  let query;
  try {
    query = parseListApplicationsRequest(new URL(request.url));
  } catch (error) {
    const response = applicationContractErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.jobType) where.jobType = query.jobType;
  if (query.search) {
    where.OR = [
      { jobTitle: { contains: query.search } },
      { company: { contains: query.search } },
    ];
  }

  const applications = await prisma.application.findMany({
    where,
    orderBy: { [query.sortBy]: query.sortOrder },
  });

  return NextResponse.json(applications);
});

export const POST = route.handler(async function POST(request: NextRequest) {
  let body;
  try {
    body = await parseCreateApplicationRequest(request);
  } catch (error) {
    const response = applicationContractErrorResponse(error);
    if (response) return response;
    throw error;
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
    return NextResponse.json(
      { ...application, updated: true },
      { status: 200 }
    );
  }

  const application = await prisma.application.create({
    data: {
      url: body.url,
      jobTitle: body.jobTitle,
      company: body.company,
      status: body.status,
      appliedDate: body.appliedDate ?? new Date(),
      description: body.description,
      notes: body.notes,
      salary: body.salary,
      location: body.location,
      jobType: body.jobType,
    },
  });

  return NextResponse.json(application, { status: 201 });
});
