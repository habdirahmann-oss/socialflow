import type { NextRequest } from "next/server";
import {
  igExchangeCode,
  igLongLivedToken,
  igProfile,
  saveIgConnection,
} from "@/lib/instagram";
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

  const accountId = await accountFromCallback(req, "instagram");
  if (!accountId) {
    return backToVerbindingen("instagram", "error", { reden: INVALID_STATE_REASON });
  }
  const back = (status: string, reden?: string) =>
    backToVerbindingen("instagram", status, { accountId, reden });

  if (error) return back("error", error);
  if (!code) return back("error", "geen_code");

  try {
    const short = await igExchangeCode(code);
    const long = await igLongLivedToken(short.access_token);
    const profile = await igProfile(long.token);
    const now = Date.now();
    await saveIgConnection(accountId, {
      token: long.token,
      igUserId: profile.id,
      username: profile.username,
      obtainedAt: now,
      expiresAt: long.expiresAt,
      refreshedAt: now,
      checkedAt: now,
      status: "ok",
    });
    return back("ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return back("error", msg);
  }
}
