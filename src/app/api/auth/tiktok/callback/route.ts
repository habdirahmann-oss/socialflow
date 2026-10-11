import { NextResponse } from "next/server";
import {
  tiktokExchangeCode,
  tiktokUserInfo,
  saveTikTokConnection,
  TIKTOK,
} from "@/lib/tiktok";

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
  const back = (qs: string) =>
    `${TIKTOK.appUrl}/verbindingen${accountId ? `?account=${accountId}&` : "?"}${qs}`;

  if (error) return NextResponse.redirect(back(`tt=error&reden=${encodeURIComponent(error)}`));
  if (!code) return NextResponse.redirect(back("tt=error&reden=geen_code"));
  if (!accountId) return NextResponse.redirect(`${TIKTOK.appUrl}/verbindingen?tt=error&reden=geen_account`);

  try {
    const tokens = await tiktokExchangeCode(code);
    const profile = await tiktokUserInfo(tokens.access_token);
    await saveTikTokConnection(accountId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 86400) * 1000,
      openId: tokens.open_id || profile.openId,
      displayName: profile.displayName,
      obtainedAt: Date.now(),
    });
    return NextResponse.redirect(back("tt=ok"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return NextResponse.redirect(back(`tt=error&reden=${encodeURIComponent(msg)}`));
  }
}
