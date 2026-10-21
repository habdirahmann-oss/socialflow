import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { loadTikTokConnection, tiktokCreatorInfo } from "@/lib/tiktok";

export const runtime = "nodejs";

/** GET /api/tiktok/creator-info?account= — naam, avatar en postopties van de maker. */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const accountId = new URL(req.url).searchParams.get("account") || "";
  const conn = accountId ? await loadTikTokConnection(accountId) : null;
  if (!conn) return NextResponse.json({ error: "Geen TikTok-account gekoppeld" }, { status: 404 });
  try {
    return NextResponse.json(await tiktokCreatorInfo(conn, 8000));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "TikTok-gegevens ophalen mislukt" },
      { status: 502 },
    );
  }
}
