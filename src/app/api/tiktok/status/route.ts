import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { loadTikTokConnection } from "@/lib/tiktok";

export const runtime = "nodejs";

/**
 * GET /api/tiktok/status?account=&id= — wat TikTok zelf over een upload zegt
 * (bv. SEND_TO_USER_INBOX, PUBLISH_COMPLETE of FAILED met reden).
 */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const accountId = params.get("account") || "";
  const publishId = params.get("id") || "";
  if (!accountId || !publishId) {
    return NextResponse.json({ error: "account en id zijn verplicht" }, { status: 400 });
  }
  const conn = await loadTikTokConnection(accountId);
  if (!conn) return NextResponse.json({ error: "Geen TikTok-account gekoppeld" }, { status: 404 });
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: {
      authorization: `Bearer ${conn.accessToken}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return NextResponse.json({ error: "TikTok niet bereikbaar" }, { status: 502 });
  const body = (await res.json().catch(() => ({}))) as {
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
  return NextResponse.json({ httpStatus: res.status, data: body.data ?? null, error: body.error ?? null });
}
