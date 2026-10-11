import { NextResponse } from "next/server";
import {
  exchangeCodeForToken,
  getLongLivedToken,
  fetchPages,
  saveMetaStore,
  loadMetaStore,
  META,
} from "@/lib/meta";

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
  const base = META.appUrl;
  const back = (qs: string) =>
    `${base}/verbindingen${accountId ? `?account=${accountId}&` : "?"}${qs}`;

  if (error) {
    return NextResponse.redirect(back(`meta=error&reden=${encodeURIComponent(error)}`));
  }
  if (!code) {
    return NextResponse.redirect(back("meta=error&reden=geen_code"));
  }
  if (!accountId) {
    return NextResponse.redirect(`${base}/verbindingen?meta=error&reden=geen_account`);
  }

  try {
    const shortToken = await exchangeCodeForToken(code);
    const longToken = await getLongLivedToken(shortToken);
    const pages = await fetchPages(longToken);
    // behoud de eerder gekozen pagina als die er nog is
    const prev = await loadMetaStore(accountId);
    const keep =
      prev?.selectedPageId && pages.some((p) => p.id === prev.selectedPageId)
        ? prev.selectedPageId
        : undefined;
    await saveMetaStore(accountId, {
      userToken: longToken,
      pages,
      obtainedAt: Date.now(),
      selectedPageId: keep,
    });
    return NextResponse.redirect(back("meta=ok"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return NextResponse.redirect(back(`meta=error&reden=${encodeURIComponent(msg)}`));
  }
}
