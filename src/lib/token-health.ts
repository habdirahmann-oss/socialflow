import { listAccounts } from "./accounts";
import { activePage, checkMetaTokenHealth, loadMetaStore, metaHealth } from "./meta";
import { checkIgTokenHealth, igHealth, loadIgConnection } from "./instagram";
import { checkTikTokTokenHealth, loadTikTokConnection, tiktokHealth } from "./tiktok";
import { checkYouTubeTokenHealth, loadYouTubeConnection, youtubeHealth } from "./youtube";
import { kvSet, kvSetNX } from "./store";
import type { AccountHealth, ChannelHealth } from "./types";

export type { AccountHealth, ChannelHealth };

/**
 * Gezondheid per kanaal van één account (nooit tokens).
 * - Meta: lees-only debug_token, lui (max. 1× per 24 uur per pagina).
 * - IG-login: wordt bij het laden zo nodig ververst (max. 1× per 24 uur).
 * - TikTok/YouTube: access-token wordt bij het laden zo nodig ververst.
 * Instagram = de IG-login als die er is (die gebruikt publish), anders de
 * Instagram van de gekozen Facebook-pagina.
 */
export async function accountHealth(accountId: string): Promise<AccountHealth> {
  const [store, ig, tt, yt] = await Promise.all([
    loadMetaStore(accountId).then((s) => checkMetaTokenHealth(accountId, { store: s })),
    loadIgConnection(accountId),
    loadTikTokConnection(accountId),
    loadYouTubeConnection(accountId),
  ]);
  const now = Date.now();
  const out: AccountHealth = {};
  const page = activePage(store);
  if (store && page) out.facebook = metaHealth(store, now);
  if (ig) out.instagram = igHealth(ig, now);
  else if (store && page?.instagram) out.instagram = metaHealth(store, now);
  if (tt) out.tiktok = tiktokHealth(tt, now);
  if (yt) out.youtube = youtubeHealth(yt, now);
  return out;
}

const HEALTH_KEY = "token-health-last";

/**
 * Dagelijkse token-run (vanuit de cron): ververst IG-tokens en doet de
 * lees-only controles voor alle accounts. Hooguit 1× per 24 uur, bewaakt
 * met de key 'token-health-last'. Geeft null als het nog niet nodig was.
 */
export async function runDailyTokenHealth(): Promise<{
  ranAt: number;
  accounts: number;
} | null> {
  const ranAt = Date.now();
  if (!(await kvSetNX(HEALTH_KEY, ranAt, 86_400))) return null;
  const accounts = await listAccounts();
  await Promise.allSettled(
    accounts.map(async (a) => {
      // Na elkaar per account: de checks schrijven elk naar hun eigen key (met lock).
      await checkMetaTokenHealth(a.id, { force: true }).catch(() => {});
      await checkIgTokenHealth(a.id).catch(() => {});
      await checkTikTokTokenHealth(a.id).catch(() => {});
      await checkYouTubeTokenHealth(a.id).catch(() => {});
    }),
  );
  const result = { ranAt, accounts: accounts.length };
  await kvSet("token-health-last-result", result).catch(() => {});
  return result;
}
