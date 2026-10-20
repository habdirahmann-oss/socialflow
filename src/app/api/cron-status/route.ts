import { NextResponse } from "next/server";
import { kvGet } from "@/lib/store";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cron-status → de laatste cron-run ({ ranAt, processed } of null). */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const lastRun = await kvGet<{ ranAt?: number; processed?: unknown[] }>("cron-last-run");
  return NextResponse.json({ lastRun: lastRun ?? null });
}
