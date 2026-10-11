import { NextResponse } from "next/server";
import {
  igExchangeCode,
  igLongLivedToken,
  igProfile,
  saveIgConnection,
  IG,
} from "@/lib/instagram";

export const runtime = "nodejs";

function accountFromState(state: string | null): string | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return typeof parsed.a === "string" ? parsed.a : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error =
    url.searchParams.get("error_description") || url.searchParams.get("error");
  const accountId = accountFromState(url.searchParams.get("state"));
  const base = IG.appUrl;
  const back = (qs: string) =>
    `${base}/verbindingen${accountId ? `?account=${accountId}&` : "?"}${qs}`;

  if (error) {
    return NextResponse.redirect(back(`ig=error&reden=${encodeURIComponent(error)}`));
  }
  if (!code) {
    return NextResponse.redirect(back("ig=error&reden=geen_code"));
  }
  if (!accountId) {
    return NextResponse.redirect(`${base}/verbindingen?ig=error&reden=geen_account`);
  }

  try {
    const short = await igExchangeCode(code);
    const longToken = await igLongLivedToken(short.access_token);
    const profile = await igProfile(longToken);
    await saveIgConnection(accountId, {
      token: longToken,
      igUserId: profile.id,
      username: profile.username,
      obtainedAt: Date.now(),
    });
    return NextResponse.redirect(back("ig=ok"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return NextResponse.redirect(back(`ig=error&reden=${encodeURIComponent(msg)}`));
  }
}
