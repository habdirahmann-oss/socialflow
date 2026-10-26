import type { NextRequest } from "next/server";
import { saveTtbConnection, ttbDisplayName, ttbExchangeCode } from "@/lib/tiktok-business";
import {
  accountFromCallback,
  backToVerbindingen,
  INVALID_STATE_REASON,
} from "@/lib/oauth-state";

export const runtime = "nodejs";

/** TikTok stuurt terug met ?auth_code=… (Business API) of ?code=…. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("auth_code") || url.searchParams.get("code");
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");

  const accountId = await accountFromCallback(req, "ttbiz");
  if (!accountId) {
    return backToVerbindingen("ttbiz", "error", { reden: INVALID_STATE_REASON });
  }
  const back = (status: string, reden?: string) =>
    backToVerbindingen("ttbiz", status, { accountId, reden });

  if (error) return back("error", error);
  if (!code) return back("error", "geen_code");

  try {
    const t = await ttbExchangeCode(code);
    const now = Date.now();
    await saveTtbConnection(accountId, {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: now + (t.expires_in || 86400) * 1000,
      refreshExpiresAt: t.refresh_token_expires_in
        ? now + t.refresh_token_expires_in * 1000
        : undefined,
      status: "ok",
      openId: t.open_id,
      displayName: await ttbDisplayName(t.access_token, t.open_id),
      obtainedAt: now,
    });
    return back("ok");
  } catch (e) {
    return back("error", e instanceof Error ? e.message : "onbekende fout");
  }
}
