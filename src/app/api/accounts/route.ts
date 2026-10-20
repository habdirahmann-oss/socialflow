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
import { accountHealth } from "@/lib/token-health";

export const runtime = "nodejs";

/**
 * Lijst met accounts, elk verrijkt met hun koppelingsstatus en `health` per
 * kanaal ({status, expiresAt?, lastError?, connectedAt?}). Nooit tokens.
 */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const accounts = await listAccounts();
  const enriched = await Promise.all(
    accounts.map(async (a) => {
      // eerst de health-check (ververst/controleert en slaat status op), dan lezen
      const health = await accountHealth(a.id);
      const [store, ig, tt, yt] = await Promise.all([
        loadMetaStore(a.id),
        loadIgConnection(a.id),
        loadTikTokConnection(a.id),
        loadYouTubeConnection(a.id),
      ]);
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
        health,
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
