import { NextResponse } from "next/server";
import { metaConfigured, metaLoginUrl, META } from "@/lib/meta";
import { accountExists } from "@/lib/accounts";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!metaConfigured()) {
    return NextResponse.json(
      { error: "Meta is niet geconfigureerd (META_APP_ID / META_APP_SECRET)" },
      { status: 500 },
    );
  }
  const accountId = new URL(req.url).searchParams.get("account") || "";
  if (!accountId || !(await accountExists(accountId))) {
    return NextResponse.redirect(`${META.appUrl}/verbindingen?meta=error&reden=geen_account`);
  }
  // account-id + tijdstempel in de state (CSRF + weten voor welk account)
  const state = Buffer.from(
    JSON.stringify({ a: accountId, t: Date.now() }),
  ).toString("base64url");
  return NextResponse.redirect(metaLoginUrl(state));
}
