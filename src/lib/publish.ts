import {
  loadMetaStore,
  activePage,
  postToFacebookPage,
  postToInstagram,
  checkFacebookPage,
  checkInstagramViaPage,
  markMetaNeedsReauth,
  needsPageChoice,
  PAGE_CHOICE_REQUIRED,
  META,
} from "./meta";
import {
  loadIgConnection,
  postToInstagramDirect,
  checkInstagramDirect,
  igNeedsReauth,
  markIgNeedsReauth,
} from "./instagram";
import { expiredMessage, errorText, isMetaTokenError } from "./token-status";
import { loadTikTokConnection, postToTikTok, tiktokUserInfo } from "./tiktok";
import { loadYouTubeConnection, postToYouTube, checkYouTube } from "./youtube";
import { saveDataUrl, validateDataUrl, isAllowedMediaUrl } from "./media";
import {
  normalizeTargets,
  fullText,
  type DroppedTarget,
  type PublishTargets,
} from "./targets";
import type { PlatformCaption } from "@/app/api/captions/route";

export { fullText, normalizeTargets };
export type { DroppedTarget, PublishTargets };

export interface PublishCaptions {
  facebook?: PlatformCaption;
  instagram?: PlatformCaption;
  tiktok?: PlatformCaption;
  youtube?: PlatformCaption;
}

export interface PublishResult {
  platform: string;
  placement: string;
  ok: boolean;
  id?: string;
  /** Link naar de geplaatste post (indien bekend). */
  url?: string;
  /** Extra info, bv. dat YouTube de video privé heeft gezet. */
  note?: string;
  error?: string;
}

export interface PublishOutcome {
  /** Minstens één plaatsing gelukt (backwards compatible). */
  ok: boolean;
  /** Alle plaatsingen gelukt. */
  allOk: boolean;
  results: PublishResult[];
  /** Plaatsingen die niet bij deze media passen en zijn overgeslagen. */
  dropped: DroppedTarget[];
  error?: string;
}

/** Media zoals de client 'm meestuurt: bij voorkeur alleen een URL. */
export interface MediaInput {
  url?: unknown;
  /** Oude route (max 4 MB): base64 data-URL. */
  dataUrl?: unknown;
  type?: unknown;
}

/**
 * Bepaalt de publieke media-URL voor een publish/schedule-aanvraag.
 * - `url`: moet van onze Blob-store of /api/media komen (SSRF-bescherming).
 * - `dataUrl`: fallback; wordt gevalideerd en (behalve in testmodus) opgeslagen.
 * In testmodus wordt nooit iets geüpload.
 * Gooit een Error met een Nederlandse melding (→ 400).
 */
export async function resolveMediaInput(
  media: MediaInput | null | undefined,
  dryRun: boolean,
): Promise<{ url: string; type: "image" | "video" } | undefined> {
  if (!media || typeof media !== "object") return undefined;
  const type: "image" | "video" = media.type === "image" ? "image" : "video";

  if (media.url !== undefined && media.url !== null && media.url !== "") {
    if (!isAllowedMediaUrl(media.url)) throw new Error("Ongeldige media-URL");
    return { url: media.url, type };
  }
  if (typeof media.dataUrl === "string" && media.dataUrl) {
    if (dryRun) {
      validateDataUrl(media.dataUrl);
      return { url: "dry-run://media", type };
    }
    const saved = await saveDataUrl(media.dataUrl);
    return { url: saved.url || `${META.appUrl}/api/media/${saved.id}`, type };
  }
  return undefined;
}

/** Time-out voor de lees-only tokencontroles in testmodus. */
const CHECK_TIMEOUT_MS = 5000;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "mislukt");

/**
 * Kern-publiceerfunctie — gedeeld door de directe "Post nu" én de cron-scheduler.
 * `mediaUrl` is al een PUBLIEKE url (geen data-URL).
 *
 * - Plaatsingen worden eerst genormaliseerd (zie targets.ts); wat niet kan,
 *   staat in `dropped`.
 * - De kanalen lopen parallel; plaatsingen binnen één kanaal na elkaar.
 * - dryRun: controleert media/plaatsing + doet goedkope LEES-ONLY
 *   tokencontroles (5 s). Er wordt niets geüpload of geplaatst.
 */
export async function publishForAccount(opts: {
  accountId: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  targets: PublishTargets;
  captions: PublishCaptions;
  dryRun?: boolean;
}): Promise<PublishOutcome> {
  const { accountId, mediaUrl, dryRun } = opts;
  const captions: PublishCaptions = opts.captions || {};
  const kind: "image" | "video" | undefined = mediaUrl
    ? opts.mediaType === "image"
      ? "image"
      : "video"
    : undefined;
  const media = mediaUrl && kind ? { url: mediaUrl, kind } : undefined;

  const { targets, dropped } = normalizeTargets(opts.targets, kind);

  // load*Connection verversen TikTok/YouTube (en IG) zelf vóór het posten;
  // mislukt dat definitief, dan staat status op 'needs_reauth'.
  const [store, igConn, ttConn, ytConn] = await Promise.all([
    loadMetaStore(accountId),
    loadIgConnection(accountId),
    loadTikTokConnection(accountId),
    loadYouTubeConnection(accountId),
  ]);
  const page = activePage(store);
  /** Nieuwe Meta-koppeling met meerdere pagina's en nog geen keuze. */
  const pageChoice = needsPageChoice(store);

  if (!page && !igConn && !ttConn && !ytConn) {
    return {
      ok: false,
      allOk: false,
      results: [],
      dropped,
      error: pageChoice ? PAGE_CHOICE_REQUIRED : "Dit account is nog niet verbonden",
    };
  }
  const total = Object.values(targets).reduce((n, v) => n + (v?.length || 0), 0);
  if (total === 0) {
    const why = dropped.length
      ? `: ${dropped.map((d) => `${d.platform} ${d.placement} (${d.reason})`).join(", ")}`
      : "";
    return {
      ok: false,
      allOk: false,
      results: [],
      dropped,
      error: `Niets om te plaatsen met deze media${why}`,
    };
  }

  /**
   * Draait de plaatsingen van één kanaal na elkaar. `check` is de lees-only
   * controle voor testmodus (één keer per kanaal); `post` plaatst echt.
   */
  async function runPlatform(
    platform: keyof PublishTargets,
    placements: string[] | undefined,
    setup: () => string | null,
    check: () => Promise<void>,
    post: (placement: string) => Promise<Omit<PublishResult, "platform" | "placement" | "ok">>,
  ): Promise<PublishResult[]> {
    const out: PublishResult[] = [];
    if (!placements?.length) return out;
    const fail = (placement: string, error: string) =>
      out.push({ platform, placement, ok: false, error });

    const missing = setup();
    if (missing) {
      for (const p of placements) fail(p, missing);
      return out;
    }
    if (dryRun) {
      let error: string | undefined;
      try {
        await check();
      } catch (e) {
        error = errMsg(e);
      }
      for (const p of placements) {
        if (error) fail(p, error);
        else out.push({ platform, placement: p, ok: true, id: "dry-run" });
      }
      return out;
    }
    for (const p of placements) {
      try {
        const r = await post(p);
        out.push({ platform, placement: p, ok: true, ...r });
      } catch (e) {
        fail(p, errMsg(e));
      }
    }
    return out;
  }

  const igId = page?.instagram?.id;

  // ---------- Token-gezondheid (T7) ----------
  // Status 'needs_reauth' → meteen een duidelijke melding, geen zinloze poging.
  let metaDead = store?.status === "needs_reauth";
  let igDirectDead = igConn ? igNeedsReauth(igConn) : false;
  /** Instagram via de Facebook-pagina kan als terugval dienen. */
  const pageIgUsable = () => Boolean(igId && page && !metaDead);

  /** Meta-fout 190 (pagina-token) → Meta-koppeling op 'opnieuw verbinden nodig'. */
  async function viaMeta<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isMetaTokenError(e)) {
        metaDead = true;
        await markMetaNeedsReauth(accountId, errorText(e)).catch(() => {});
      }
      throw e;
    }
  }

  /**
   * Instagram: eerst de IG-login (als die geldig is). Bij fout 190 → IG-login op
   * needs_reauth en, als de pagina een Instagram heeft, terugvallen op het
   * pagina-pad. `direct` en `viaPage` zijn de check- of post-varianten.
   */
  async function igWithFallback<T>(
    direct: () => Promise<T>,
    viaPage: () => Promise<T>,
  ): Promise<T> {
    if (igConn && !igDirectDead) {
      try {
        return await direct();
      } catch (e) {
        if (!isMetaTokenError(e)) throw e;
        igDirectDead = true;
        await markIgNeedsReauth(accountId, errorText(e)).catch(() => {});
        if (!pageIgUsable()) throw e;
      }
    }
    return viaMeta(viaPage);
  }

  const blocks: Promise<PublishResult[]>[] = [
    // ---------- Facebook ----------
    runPlatform(
      "facebook",
      targets.facebook,
      () => {
        if (!page) return pageChoice ? PAGE_CHOICE_REQUIRED : "Geen Facebook-pagina verbonden";
        if (metaDead) return expiredMessage("Facebook");
        return null;
      },
      () => viaMeta(() => checkFacebookPage(page!, CHECK_TIMEOUT_MS)),
      async () => {
        const r = await viaMeta(() =>
          postToFacebookPage(page!, fullText(captions.facebook), media),
        );
        return { id: r.id, url: r.url };
      },
    ),

    // ---------- Instagram ----------
    runPlatform(
      "instagram",
      targets.instagram,
      () => {
        if (!igConn && !igId) {
          return pageChoice ? PAGE_CHOICE_REQUIRED : "Geen Instagram-account gekoppeld";
        }
        // IG-login verlopen en geen bruikbare pagina-Instagram, of alleen het
        // pagina-pad en dat is verlopen
        const directOk = Boolean(igConn && !igDirectDead);
        if (!directOk && !pageIgUsable()) return expiredMessage("Instagram");
        if (!media) return "Instagram heeft een foto of video nodig";
        return null;
      },
      () =>
        igWithFallback(
          () => checkInstagramDirect(igConn!.token, CHECK_TIMEOUT_MS),
          () => checkInstagramViaPage(igId!, page!.accessToken, CHECK_TIMEOUT_MS),
        ),
      async (placement) => {
        const caption = fullText(captions.instagram);
        // Na normalisatie: story | reel (video) | feed (foto)
        const plc =
          placement === "story" ? "story" : media!.kind === "video" ? "reel" : "feed";
        const r = await igWithFallback(
          () => postToInstagramDirect(igConn!, media!, caption, plc),
          () => postToInstagram(igId!, page!.accessToken, media!, caption, plc),
        );
        return { id: r.id, url: r.permalink };
      },
    ),

    // ---------- TikTok ----------
    runPlatform(
      "tiktok",
      targets.tiktok,
      () => {
        if (!ttConn) return "Geen TikTok-account gekoppeld";
        if (ttConn.status === "needs_reauth") return expiredMessage("TikTok");
        if (!media || media.kind !== "video") return "TikTok heeft een video nodig";
        return null;
      },
      async () => {
        await tiktokUserInfo(ttConn!.accessToken, {
          label: "TikTok-koppeling",
          timeoutMs: CHECK_TIMEOUT_MS,
        });
      },
      async () => {
        const r = await postToTikTok(ttConn!, media!.url, fullText(captions.tiktok));
        return { id: r.id };
      },
    ),

    // ---------- YouTube ----------
    runPlatform(
      "youtube",
      targets.youtube,
      () => {
        if (!ytConn) return "Geen YouTube-kanaal gekoppeld";
        if (ytConn.status === "needs_reauth") return expiredMessage("YouTube");
        if (!media || media.kind !== "video") return "YouTube heeft een video nodig";
        return null;
      },
      () => checkYouTube(ytConn!.accessToken, CHECK_TIMEOUT_MS),
      async (placement) => {
        const c = captions.youtube;
        const r = await postToYouTube(
          ytConn!,
          media!.url,
          c?.title || c?.caption?.slice(0, 90) || "Nieuwe video",
          fullText(c),
          placement === "short" ? "short" : "video",
        );
        return {
          id: r.id,
          url: r.url,
          note:
            r.privacyStatus === "private"
              ? "privé gezet door YouTube (project niet geverifieerd)"
              : undefined,
        };
      },
    ),
  ];

  const settled = await Promise.allSettled(blocks);
  const order = ["facebook", "instagram", "tiktok", "youtube"] as const;
  const results: PublishResult[] = settled.flatMap((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : (targets[order[i]] || []).map((placement) => ({
          platform: order[i],
          placement,
          ok: false,
          error: errMsg(s.reason),
        })),
  );

  return {
    ok: results.some((r) => r.ok),
    allOk: results.length > 0 && results.every((r) => r.ok),
    results,
    dropped,
  };
}
