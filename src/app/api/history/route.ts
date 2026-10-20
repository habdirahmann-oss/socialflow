import { NextResponse } from "next/server";
import { listHistory } from "@/lib/history";
import { requireAuth } from "@/lib/auth";
import { postView, parseStatusFilter } from "@/lib/post-view";

export const runtime = "nodejs";

/** GET /api/history?accountId=&status=posted,partial — nieuwste eerst. */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const accountId = params.get("accountId");
  const statuses = parseStatusFilter(params.get("status"));
  const entries = (await listHistory())
    .filter((e) => !accountId || e.accountId === accountId)
    .filter((e) => !statuses || statuses.has(e.status));
  return NextResponse.json({ entries: entries.map(postView) });
}
