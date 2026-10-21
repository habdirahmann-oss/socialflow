import { NextResponse } from "next/server";
import {
  listAccounts,
  createAccount,
  renameAccount,
  deleteAccount,
  AccountLimitError,
  MAX_ACCOUNTS,
  MAX_ACCOUNTS_ERROR,
} from "@/lib/accounts";
import {
  loadMetaStore,
  clearMetaStore,
  metaConfigured,
  activePage,
  needsPageChoice,
  implicitPageFallback,
} from "@/lib/meta";
import {
  loadIgConnection,
  clearIgConnection,
  igConfigured,
  igNeedsReauth,
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
import { cancelPendingForAccount, pendingCountByAccount } from "@/lib/schedule";
import { APP_URL } from "@/lib/config";
import type { AccountInfo, AccountsResponse } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Lijst met accounts, elk verrijkt met hun koppelingsstatus en `health` per
 * kanaal ({status, expiresAt?, lastError?, connectedAt?}). Nooit tokens.
 */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const accounts = await listAccounts();
  const pendingByAccount = await pendingCountByAccount().catch(
    () => ({}) as Record<string, number>,
  );
  const enriched = await Promise.all(
    accounts.map(async (a): Promise<AccountInfo> => {
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
      // Welke Instagram-route publish gebruikt: eerst de losse IG-login (als
      // die geldig is), anders de Instagram van de gekozen Facebook-pagina.
      const igPublishVia =
        ig && !igNeedsReauth(ig)
          ? { username: ig.username, route: "login" as const }
          : active?.instagram
            ? { username: active.instagram.username, route: "page" as const }
            : ig
              ? { username: ig.username, route: "login" as const }
              : null;
      return {
        ...a,
        facebook: pages.length > 0,
        instagram: Boolean(active?.instagram),
        pages,
        /** De pagina waarmee dit account nu post (null = nog kiezen). */
        selectedPageId: active?.id ?? null,
        /** Nieuwe koppeling met meerdere pagina's zonder keuze → posten geblokkeerd. */
        pageChoiceRequired: needsPageChoice(store),
        /** Oude koppeling die stil op de eerste pagina terugvalt. */
        implicitPage: implicitPageFallback(store),
        igPublishVia,
        pendingPosts: pendingByAccount[a.id] || 0,
        connectedAt: store?.obtainedAt || null,
        igLogin: ig ? { username: ig.username } : null,
        tiktok: tt ? { displayName: tt.displayName } : null,
        youtube: yt ? { channelTitle: yt.channelTitle } : null,
        health,
      };
    }),
  );
  return NextResponse.json<AccountsResponse>({
    configured: metaConfigured(),
    igConfigured: igConfigured(),
    tiktokConfigured: tiktokConfigured(),
    youtubeConfigured: youtubeConfigured(),
    appUrl: APP_URL,
    maxAccounts: MAX_ACCOUNTS,
    accounts: enriched,
  });
}

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { name } = await req.json().catch(() => ({ name: "" }));
  try {
    const account = await createAccount(typeof name === "string" ? name : "");
    return NextResponse.json(account);
  } catch (e) {
    if (e instanceof AccountLimitError) {
      return NextResponse.json({ error: MAX_ACCOUNTS_ERROR }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Account aanmaken mislukt" },
      { status: 503 },
    );
  }
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
  // eerst de wachtende posts annuleren, anders zou de cron ze nog proberen
  const cancelled = await cancelPendingForAccount(id);
  await clearMetaStore(id); // tokens opruimen
  await clearIgConnection(id);
  await clearTikTokConnection(id);
  await clearYouTubeConnection(id);
  await deleteAccount(id);
  return NextResponse.json({ ok: true, cancelledPosts: cancelled.length });
}
