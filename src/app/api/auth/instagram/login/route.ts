import { NextResponse, type NextRequest } from "next/server";
import { igConfigured, igLoginUrl } from "@/lib/instagram";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";
import { makeState, setStateCookie, verbindingenUrl } from "@/lib/oauth-state";

export const runtime = "nodejs";

/**
 * Start de Instagram-koppeling: ondertekende state (account + nonce) mee naar
 * Instagram; de nonce gaat ook in een httpOnly-cookie die de callback controleert.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  if (!igConfigured()) {
    return NextResponse.json(
      { error: "Instagram is niet geconfigureerd (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(verbindingenUrl("instagram", "error", { reden: "geen_account" }));
  }
  const { state, nonce } = makeState(accountId, "instagram");
  const res = NextResponse.redirect(igLoginUrl(state));
  setStateCookie(res, "instagram", nonce);
  return res;
}
