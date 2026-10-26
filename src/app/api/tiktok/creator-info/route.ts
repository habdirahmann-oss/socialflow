import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { loadTikTokConnection, tiktokCreatorInfo } from "@/lib/tiktok";
import { loadTtbConnection } from "@/lib/tiktok-business";
import type { TikTokCreatorInfo } from "@/lib/tiktok-settings";

export const runtime = "nodejs";

/** GET /api/tiktok/creator-info?account= — naam, avatar en postopties van de maker. */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const accountId = new URL(req.url).searchParams.get("account") || "";
  // TikTok Business-koppeling: publiceert altijd openbaar op het eigen account.
  const ttb = accountId ? await loadTtbConnection(accountId) : null;
  if (ttb && ttb.status !== "needs_reauth") {
    return NextResponse.json<TikTokCreatorInfo>({
      nickname: ttb.displayName,
      username: "",
      avatarUrl: "",
      privacyOptions: ["PUBLIC_TO_EVERYONE"],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      maxVideoSeconds: 600,
    });
  }
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
