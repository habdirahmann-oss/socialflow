import { NextResponse } from "next/server";
import { tiktokConfigured, tiktokLoginUrl, TIKTOK } from "@/lib/tiktok";
import { accountExists } from "@/lib/accounts";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!tiktokConfigured()) {
    return NextResponse.json(
      { error: "TikTok is niet geconfigureerd (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(`${TIKTOK.appUrl}/verbindingen?tt=error&reden=geen_account`);
  }
  const state = Buffer.from(
    JSON.stringify({ a: accountId, t: Date.now() }),
  ).toString("base64url");
  return NextResponse.redirect(tiktokLoginUrl(state));
}
