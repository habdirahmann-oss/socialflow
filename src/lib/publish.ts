import {
  loadMetaStore,
  activePage,
  postToFacebookPage,
  postToInstagram,
  checkFacebookPage,
  checkInstagramViaPage,
  markMetaNeedsReauth,
  postAlbumToFacebookPage,
  postStoryToFacebookPage,
  postCarouselToInstagram,
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
  postCarouselToInstagramDirect,
} from "./instagram";
import { expiredMessage, errorText, isMetaTokenError } from "./token-status";
import { loadTtbConnection, ttbPublishPhotos, ttbPublishVideo } from "./tiktok-business";
import {
  loadTikTokConnection,
  postToTikTok,
  postPhotosToTikTok,
  tiktokUserInfo,
} from "./tiktok";
import { loadYouTubeConnection, postToYouTube, checkYouTube } from "./youtube";
import { saveDataUrl, validateDataUrl, isAllowedMediaUrl, appMediaUrl } from "./media";
import { IG_CAROUSEL_MAX } from "./ig-media";
import {
  normalizeTargets,
  fullText,
  type DroppedTarget,
  type PublishTargets,
} from "./targets";
import type { PlatformId } from "./platforms";
import type { MediaKind, PlatformCaption } from "./types";

export { fullText, normalizeTargets };
export type { DroppedTarget, PublishTargets };

export interface PublishCaptions {
  facebook?: PlatformCaption;
  instagram?: PlatformCaption;
  tiktok?: PlatformCaption;
  youtube?: PlatformCaption;
}

export interface PublishResult {
  /** '-' = algemene fout van een poging (niet aan één kanaal gebonden). */
  platform: PlatformId | "-";
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
  media: MediaInput | MediaInput[] | null | undefined,
  dryRun: boolean,
): Promise<{ url: string; type: MediaKind; urls?: string[] } | undefined> {
  // Carrousel: lijst met foto-URL's (2–10, alleen foto's).
  if (Array.isArray(media)) {
    if (media.length === 1) return resolveMediaInput(media[0], dryRun);
    if (media.length < 2 || media.length > IG_CAROUSEL_MAX) {
      throw new Error(`Een carrousel heeft 2 t/m ${IG_CAROUSEL_MAX} foto's`);
    }
    const urls: string[] = [];
    for (const m of media) {
      if (!m || typeof m !== "object" || m.type !== "image" || !isAllowedMediaUrl(m.url)) {
        throw new Error("Carrousel: alleen foto's met een geldige media-URL");
      }
      urls.push(m.url);
    }
    return { url: urls[0], type: "image", urls };
  }
  if (!media || typeof media !== "object") return undefined;
  const type: MediaKind = media.type === "image" ? "image" : "video";

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

/**
 * Standaard-tijdsbudget voor één publicatie-aanroep. Alle routes die publiceren
 * hebben maxDuration 300 s; zo blijft er tijd over om resultaten op te slaan.
 */
export const DEFAULT_PUBLISH_BUDGET_MS = 265_000;
/** Een plaatsing starten we alleen als er nog minstens zoveel tijd over is. */
const MIN_PLACEMENT_MS = 60_000;
/** Melding voor een plaatsing die bewust niet gestart is (veilig opnieuw te proberen). */
export const NOT_STARTED_ERROR =
  "Niet gestart: de tijdslimiet van deze run was bijna bereikt. Er is niets geplaatst; probeer opnieuw.";

/** TikTok zonder Direct Post-audit: de post staat als concept in de TikTok-inbox. */
const TIKTOK_DRAFT_NOTE =
  "als concept in je TikTok-inbox gezet — open TikTok en tik op Plaatsen";

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
  mediaType?: MediaKind;
  /** Carrousel: alle foto-URL's op volgorde (mediaUrl = de eerste). */
  mediaUrls?: string[];
  targets: PublishTargets;
  captions: PublishCaptions;
  dryRun?: boolean;
  /**
   * Uiterste tijdstip (epoch ms). Na `deadline - 60 s` start er geen nieuwe
   * plaatsing meer en IG-video's krijgen alleen de resterende tijd.
   * Standaard: nu + 265 s.
   */
  deadline?: number;
  /** Wordt aangeroepen na elke echte plaatsing (om tussentijds op te slaan). */
  onResult?: (r: PublishResult) => Promise<void> | void;
}): Promise<PublishOutcome> {
  const { accountId, mediaUrl, dryRun, onResult } = opts;
  const deadline = opts.deadline ?? Date.now() + DEFAULT_PUBLISH_BUDGET_MS;
  const captions: PublishCaptions = opts.captions || {};
  const kind: MediaKind | undefined = mediaUrl
    ? opts.mediaType === "image"
      ? "image"
      : "video"
    : undefined;
  const media = mediaUrl && kind ? { url: mediaUrl, kind } : undefined;
  /** Foto's van deze post (1 bij een losse foto, 2–10 bij een carrousel). */
  const images =
    kind === "image" ? (opts.mediaUrls?.length ? opts.mediaUrls : [mediaUrl!]) : [];
  const carousel = images.length > 1;

  const { targets, dropped } = normalizeTargets(opts.targets, kind);

  // load*Connection verversen TikTok/YouTube (en IG) zelf vóór het posten;
  // mislukt dat definitief, dan staat status op 'needs_reauth'.
  const [store, igConn, ttConn, ttbConn, ytConn] = await Promise.all([
    loadMetaStore(accountId),
    loadIgConnection(accountId),
    loadTikTokConnection(accountId),
    loadTtbConnection(accountId),
    loadYouTubeConnection(accountId),
  ]);
  /** TikTok Business-koppeling (direct openbaar) gaat voor de gewone koppeling. */
  const ttbUsable = Boolean(ttbConn && ttbConn.status !== "needs_reauth");
  const page = activePage(store);
  /** Nieuwe Meta-koppeling met meerdere pagina's en nog geen keuze. */
  const pageChoice = needsPageChoice(store);

  if (!page && !igConn && !ttConn && !ttbConn && !ytConn) {
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
      if (Date.now() > deadline - MIN_PLACEMENT_MS) {
        fail(p, NOT_STARTED_ERROR);
      } else {
        try {
          const r = await post(p);
          out.push({ platform, placement: p, ok: true, ...r });
        } catch (e) {
          fail(p, errMsg(e));
        }
      }
      if (onResult) {
        try {
          await onResult(out[out.length - 1]);
        } catch {
          // tussentijds opslaan is best effort
        }
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
      async (placement) => {
        if (placement === "story") {
          // Story = één item; bij een carrousel de eerste foto.
          const r = await viaMeta(() =>
            postStoryToFacebookPage(page!, carousel ? { url: images[0], kind: "image" } : media!),
          );
          return { id: r.id };
        }
        const r = await viaMeta(() =>
          carousel
            ? postAlbumToFacebookPage(page!, fullText(captions.facebook), images)
            : postToFacebookPage(page!, fullText(captions.facebook), media),
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
        if (carousel && placement !== "story") {
          const r = await igWithFallback(
            () => postCarouselToInstagramDirect(igConn!, images, caption),
            () => postCarouselToInstagram(igId!, page!.accessToken, images, caption),
          );
          return { id: r.id, url: r.permalink };
        }
        // Na normalisatie: story | reel (video) | feed (foto)
        const plc =
          placement === "story" ? "story" : media!.kind === "video" ? "reel" : "feed";
        // Story bij een carrousel: de eerste foto.
        const item = carousel ? { url: images[0], kind: "image" as const } : media!;
        const r = await igWithFallback(
          () => postToInstagramDirect(igConn!, item, caption, plc, deadline),
          () => postToInstagram(igId!, page!.accessToken, item, caption, plc, deadline),
        );
        return { id: r.id, url: r.permalink };
      },
    ),

    // ---------- TikTok ----------
    runPlatform(
      "tiktok",
      targets.tiktok,
      () => {
        if (!ttbUsable) {
          if (!ttConn) return ttbConn ? expiredMessage("TikTok") : "Geen TikTok-account gekoppeld";
          if (ttConn.status === "needs_reauth") return expiredMessage("TikTok");
        }
        if (!media) return "TikTok heeft een video of foto nodig";
        return null;
      },
      async () => {
        if (ttbUsable) return; // token is net ververst door loadTtbConnection
        await tiktokUserInfo(ttConn!.accessToken, {
          label: "TikTok-koppeling",
          timeoutMs: CHECK_TIMEOUT_MS,
        });
      },
      async () => {
        if (ttbUsable) {
          // TikTok Business API: direct openbaar op het account
          const caption = fullText(captions.tiktok);
          const settings = captions.tiktok?.tiktok;
          const r =
            media!.kind === "image"
              ? await ttbPublishPhotos(
                  ttbConn!,
                  images.map(appMediaUrl),
                  caption,
                  captions.tiktok?.title,
                  settings,
                )
              : await ttbPublishVideo(ttbConn!, appMediaUrl(media!.url), caption, settings);
          return { id: r.id };
        }
        if (media!.kind === "image") {
          // Fotopost: TikTok haalt de foto's op via ons geverifieerde domein.
          const r = await postPhotosToTikTok(
            ttConn!,
            images.map(appMediaUrl),
            fullText(captions.tiktok),
            captions.tiktok?.title,
            captions.tiktok?.tiktok,
          );
          return { id: r.id, note: r.draft ? TIKTOK_DRAFT_NOTE : "fotopost" };
        }
        const r = await postToTikTok(
          ttConn!,
          media!.url,
          fullText(captions.tiktok),
          captions.tiktok?.tiktok,
        );
        return { id: r.id, note: r.draft ? TIKTOK_DRAFT_NOTE : undefined };
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
