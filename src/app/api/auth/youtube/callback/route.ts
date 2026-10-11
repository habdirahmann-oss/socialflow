import { NextResponse } from "next/server";
import {
  youtubeExchangeCode,
  youtubeChannel,
  saveYouTubeConnection,
  YT,
} from "@/lib/youtube";

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
  const error = url.searchParams.get("error");
  const accountId = accountFromState(url.searchParams.get("state"));
  const back = (qs: string) =>
    `${YT.appUrl}/verbindingen${accountId ? `?account=${accountId}&` : "?"}${qs}`;

  if (error) return NextResponse.redirect(back(`yt=error&reden=${encodeURIComponent(error)}`));
  if (!code) return NextResponse.redirect(back("yt=error&reden=geen_code"));
  if (!accountId) return NextResponse.redirect(`${YT.appUrl}/verbindingen?yt=error&reden=geen_account`);

  try {
    const tokens = await youtubeExchangeCode(code);
    const channel = await youtubeChannel(tokens.access_token);
    await saveYouTubeConnection(accountId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      channelId: channel.id,
      channelTitle: channel.title,
      obtainedAt: Date.now(),
    });
    return NextResponse.redirect(back("yt=ok"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return NextResponse.redirect(back(`yt=error&reden=${encodeURIComponent(msg)}`));
  }
}
