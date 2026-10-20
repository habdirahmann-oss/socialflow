import { NextResponse } from "next/server";
import {
  listAccounts,
  createAccount,
  renameAccount,
  deleteAccount,
} from "@/lib/accounts";
import {
  loadMetaStore,
  clearMetaStore,
  metaConfigured,
  activePage,
} from "@/lib/meta";
import {
  loadIgConnection,
  clearIgConnection,
  igConfigured,
} from "@/lib/instagram";
import {
  loadTikTokConnection,
  clearTikTokConnection,
  tiktokConfigured,
} from "@/lib/tiktok";
import {
  loadYouTubeConnection,
  clearYouTubeConnection,
  youtubeConfigured,
} from "@/lib/youtube";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";

/** Lijst met accounts, elk verrijkt met hun koppelingsstatus. */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const accounts = await listAccounts();
  const enriched = await Promise.all(
    accounts.map(async (a) => {
      const store = await loadMetaStore(a.id);
      const ig = await loadIgConnection(a.id);
      const tt = await loadTikTokConnection(a.id);
      const yt = await loadYouTubeConnection(a.id);
      const pages = (store?.pages || []).map((p) => ({
        id: p.id,
        name: p.name,
        instagram: p.instagram?.username || null,
      }));
      const active = activePage(store);
      return {
        ...a,
        facebook: pages.length > 0,
        instagram: Boolean(active?.instagram),
        pages,
        selectedPageId: active?.id ?? null,
        connectedAt: store?.obtainedAt || null,
        igLogin: ig ? { username: ig.username } : null,
        tiktok: tt ? { displayName: tt.displayName } : null,
        youtube: yt ? { channelTitle: yt.channelTitle } : null,
      };
    }),
  );
  return NextResponse.json({
    configured: metaConfigured(),
    igConfigured: igConfigured(),
    tiktokConfigured: tiktokConfigured(),
    youtubeConfigured: youtubeConfigured(),
    accounts: enriched,
  });
}

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { name } = await req.json().catch(() => ({ name: "" }));
  const account = await createAccount(name || "");
  return NextResponse.json(account);
}

export async function PATCH(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { id, name } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "id ontbreekt" }, { status: 400 });
  await renameAccount(id, name || "");
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id ontbreekt" }, { status: 400 });
  await clearMetaStore(id); // tokens opruimen
  await clearIgConnection(id);
  await clearTikTokConnection(id);
  await clearYouTubeConnection(id);
  await deleteAccount(id);
  return NextResponse.json({ ok: true });
}
