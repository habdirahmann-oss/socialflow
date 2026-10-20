import { NextResponse, type NextRequest } from "next/server";
import { metaConfigured, metaLoginUrl } from "@/lib/meta";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";
import { makeState, setStateCookie, verbindingenUrl } from "@/lib/oauth-state";

export const runtime = "nodejs";

/**
 * Start de Facebook-koppeling: ondertekende state (account + nonce) mee naar
 * Facebook; de nonce gaat ook in een httpOnly-cookie die de callback controleert.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  if (!metaConfigured()) {
    return NextResponse.json(
      { error: "Meta is niet geconfigureerd (META_APP_ID / META_APP_SECRET)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(verbindingenUrl("meta", "error", { reden: "geen_account" }));
  }
  const { state, nonce } = makeState(accountId, "meta");
  const res = NextResponse.redirect(metaLoginUrl(state));
  setStateCookie(res, "meta", nonce);
  return res;
}
