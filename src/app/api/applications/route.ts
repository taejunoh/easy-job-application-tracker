import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createProtectedRoute } from "@/lib/security/protected-route";
import {
  applicationContractErrorResponse,
  parseCreateApplicationRequest,
  parseListApplicationsRequest,
} from "@/lib/applications/contract";
import {
  ApplicationIdentityCollisionError,
  createApplicationAtomically,
} from "@/lib/applications/atomic-create";
import { createPrismaApplicationIdentityStore } from "@/lib/applications/prisma-identity-store";
import { getServerEnv } from "@/lib/server-env";
import { applicationWriteGuard } from "@/lib/security/application-writes";

export const maxDuration = 30;

const route = createProtectedRoute(["GET", "POST"], {
  installationMethods: ["POST"],
  writeMethods: ["POST"],
});
const identityStore = createPrismaApplicationIdentityStore(prisma);

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

  if (!getServerEnv().applicationIdentityWritesEnabled) {
    const stopped = applicationWriteGuard();
    if (stopped) return stopped;
    const application = await prisma.application.create({
      data: {
        url: body.url,
        jobTitle: body.jobTitle,
        company: body.company,
        status: body.status,
        ...(body.appliedDate === undefined ? {} : { appliedDate: body.appliedDate }),
        description: body.description,
        notes: body.notes,
        salary: body.salary,
        location: body.location,
        jobType: body.jobType,
      },
    });
    return NextResponse.json({ ...application, result: "created" }, { status: 201 });
  }

  try {
    const stopped = applicationWriteGuard();
    if (stopped) return stopped;
    const created = await createApplicationAtomically(body, { store: identityStore });
    return NextResponse.json(
      { ...created.application, result: created.result },
      { status: created.result === "created" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof ApplicationIdentityCollisionError) {
      return NextResponse.json(
        {
          error: "Application identity collision",
          code: "identity_collision",
        },
        { status: 409 },
      );
    }
    throw error;
  }
});
