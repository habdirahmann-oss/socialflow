import { NextResponse, type NextRequest } from "next/server";
import { tiktokConfigured, tiktokLoginUrl } from "@/lib/tiktok";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";
import { makeState, setStateCookie, verbindingenUrl } from "@/lib/oauth-state";

export const runtime = "nodejs";

/**
 * Start de TikTok-koppeling: ondertekende state (account + nonce) mee naar
 * TikTok; de nonce gaat ook in een httpOnly-cookie die de callback controleert.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  if (!tiktokConfigured()) {
    return NextResponse.json(
      { error: "TikTok is niet geconfigureerd (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(verbindingenUrl("tiktok", "error", { reden: "geen_account" }));
  }
  const { state, nonce } = makeState(accountId, "tiktok");
  const res = NextResponse.redirect(tiktokLoginUrl(state));
  setStateCookie(res, "tiktok", nonce);
  return res;
}
