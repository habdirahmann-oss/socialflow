import { NextResponse } from "next/server";
import { clearMetaStore, setSelectedPage } from "@/lib/meta";
import { clearIgConnection } from "@/lib/instagram";
import { clearTikTokConnection } from "@/lib/tiktok";
import { clearTtbConnection } from "@/lib/tiktok-business";
import { clearYouTubeConnection } from "@/lib/youtube";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";

/** Ontkoppel een koppeling van één account. type=meta | ig | tiktok | ttbiz | youtube. */
export async function DELETE(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const accountId = url.searchParams.get("account");
  const type = url.searchParams.get("type") || "meta";
  if (!accountId) {
    return NextResponse.json({ error: "account ontbreekt" }, { status: 400 });
  }
  if (type === "ig") await clearIgConnection(accountId);
  else if (type === "tiktok") await clearTikTokConnection(accountId);
  else if (type === "ttbiz") await clearTtbConnection(accountId);
  else if (type === "youtube") await clearYouTubeConnection(accountId);
  else await clearMetaStore(accountId);
  return NextResponse.json({ ok: true });
}

/** Kies met welke Facebook-pagina (en bijbehorend Instagram) dit account post. */
export async function PATCH(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { accountId, pageId } = await req.json().catch(() => ({}));
  if (!accountId || !pageId) {
    return NextResponse.json(
      { error: "accountId en pageId zijn verplicht" },
      { status: 400 },
    );
  }
  const ok = await setSelectedPage(accountId, pageId);
  if (!ok) {
    return NextResponse.json(
      { error: "Onbekend account of pagina" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
