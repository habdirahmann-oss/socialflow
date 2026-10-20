import { NextResponse } from "next/server";
import { igConfigured, igLoginUrl, IG } from "@/lib/instagram";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
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
    return NextResponse.redirect(`${IG.appUrl}/verbindingen?ig=error&reden=geen_account`);
  }
  const state = Buffer.from(
    JSON.stringify({ a: accountId, t: Date.now() }),
  ).toString("base64url");
  return NextResponse.redirect(igLoginUrl(state));
}
