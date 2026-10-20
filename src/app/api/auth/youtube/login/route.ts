import { NextResponse } from "next/server";
import { youtubeConfigured, youtubeLoginUrl, YT } from "@/lib/youtube";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
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
    return NextResponse.redirect(`${YT.appUrl}/verbindingen?yt=error&reden=geen_account`);
  }
  const state = Buffer.from(
    JSON.stringify({ a: accountId, t: Date.now() }),
  ).toString("base64url");
  return NextResponse.redirect(youtubeLoginUrl(state));
}
