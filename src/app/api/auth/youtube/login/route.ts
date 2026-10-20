import { NextResponse, type NextRequest } from "next/server";
import { youtubeConfigured, youtubeLoginUrl } from "@/lib/youtube";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";
import { makeState, setStateCookie, verbindingenUrl } from "@/lib/oauth-state";

export const runtime = "nodejs";

/**
 * Start de YouTube-koppeling: ondertekende state (account + nonce) mee naar
 * YouTube; de nonce gaat ook in een httpOnly-cookie die de callback controleert.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  if (!youtubeConfigured()) {
    return NextResponse.json(
      { error: "YouTube is niet geconfigureerd (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(verbindingenUrl("youtube", "error", { reden: "geen_account" }));
  }
  const { state, nonce } = makeState(accountId, "youtube");
  const res = NextResponse.redirect(youtubeLoginUrl(state));
  setStateCookie(res, "youtube", nonce);
  return res;
}
