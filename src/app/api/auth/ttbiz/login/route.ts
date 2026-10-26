import { NextResponse, type NextRequest } from "next/server";
import { ttbConfigured, ttbLoginUrl } from "@/lib/tiktok-business";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";
import { makeState, setStateCookie, verbindingenUrl } from "@/lib/oauth-state";

export const runtime = "nodejs";

/** Start de TikTok Business-koppeling (direct openbaar posten). */
export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  if (!ttbConfigured()) {
    return NextResponse.json(
      { error: "TikTok Business is niet geconfigureerd (TTB_APP_ID / TTB_APP_SECRET / TTB_AUTH_URL)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(verbindingenUrl("ttbiz", "error", { reden: "geen_account" }));
  }
  const { state, nonce } = makeState(accountId, "ttbiz");
  const res = NextResponse.redirect(ttbLoginUrl(state));
  setStateCookie(res, "ttbiz", nonce);
  return res;
}
