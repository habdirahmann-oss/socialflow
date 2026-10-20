import type { NextRequest } from "next/server";
import {
  youtubeExchangeCode,
  youtubeChannel,
  saveYouTubeConnection,
  peekYouTubeConnection,
} from "@/lib/youtube";
import {
  accountFromCallback,
  backToVerbindingen,
  INVALID_STATE_REASON,
} from "@/lib/oauth-state";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const accountId = await accountFromCallback(req, "youtube");
  if (!accountId) {
    return backToVerbindingen("youtube", "error", { reden: INVALID_STATE_REASON });
  }
  const back = (status: string, reden?: string) =>
    backToVerbindingen("youtube", status, { accountId, reden });

  if (error) return back("error", error);
  if (!code) return back("error", "geen_code");

  try {
    const tokens = await youtubeExchangeCode(code);
    const channel = await youtubeChannel(tokens.access_token);
    // Google stuurt niet altijd een refresh_token mee bij opnieuw koppelen:
    // behoud dan het vorige, anders kan de koppeling niet meer verversen.
    const prev = await peekYouTubeConnection(accountId);
    await saveYouTubeConnection(accountId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || prev?.refreshToken || "",
      status: "ok",
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      channelId: channel.id,
      channelTitle: channel.title,
      obtainedAt: Date.now(),
    });
    return back("ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return back("error", msg);
  }
}
