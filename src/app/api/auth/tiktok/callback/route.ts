import type { NextRequest } from "next/server";
import {
  tiktokExchangeCode,
  tiktokUserInfo,
  saveTikTokConnection,
} from "@/lib/tiktok";
import {
  accountFromCallback,
  backToVerbindingen,
  INVALID_STATE_REASON,
} from "@/lib/oauth-state";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error =
    url.searchParams.get("error_description") || url.searchParams.get("error");

  const accountId = await accountFromCallback(req, "tiktok");
  if (!accountId) {
    return backToVerbindingen("tiktok", "error", { reden: INVALID_STATE_REASON });
  }
  const back = (status: string, reden?: string) =>
    backToVerbindingen("tiktok", status, { accountId, reden });

  if (error) return back("error", error);
  if (!code) return back("error", "geen_code");

  try {
    const tokens = await tiktokExchangeCode(code);
    const profile = await tiktokUserInfo(tokens.access_token);
    await saveTikTokConnection(accountId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 86400) * 1000,
      refreshExpiresAt: tokens.refresh_expires_in
        ? Date.now() + tokens.refresh_expires_in * 1000
        : undefined,
      status: "ok",
      openId: tokens.open_id || profile.openId,
      displayName: profile.displayName,
      obtainedAt: Date.now(),
    });
    return back("ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return back("error", msg);
  }
}
