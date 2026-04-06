import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [total, applied, interview, offer, rejected, recentApplications] =
    await Promise.all([
      prisma.application.count(),
      prisma.application.count({ where: { status: "Applied" } }),
      prisma.application.count({ where: { status: "Interview" } }),
      prisma.application.count({ where: { status: "Offer" } }),
      prisma.application.count({ where: { status: "Rejected" } }),
      prisma.application.findMany({
        orderBy: { appliedDate: "desc" },
        take: 5,
      }),
    ]);

  // Weekly count (last 7 days)
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weeklyCount = await prisma.application.count({
    where: { appliedDate: { gte: weekAgo } },
  });

  // Monthly count (last 30 days)
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const monthlyCount = await prisma.application.count({
    where: { appliedDate: { gte: monthAgo } },
  });

  return NextResponse.json({
    total,
    applied,
    interview,
    offer,
    rejected,
    weeklyCount,
    monthlyCount,
    recentApplications,
  });
}
