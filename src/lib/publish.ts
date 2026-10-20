import {
  loadMetaStore,
  activePage,
  postToFacebookPage,
  postToInstagram,
} from "./meta";
import { loadIgConnection, postToInstagramDirect } from "./instagram";
import { loadTikTokConnection, postToTikTok } from "./tiktok";
import { loadYouTubeConnection, postToYouTube } from "./youtube";
import {
  saveDataUrl,
  validateDataUrl,
  isAllowedMediaUrl,
  APP_URL,
} from "./media";
import type { PlatformCaption } from "@/app/api/captions/route";

export interface PublishTargets {
  facebook?: string[];
  instagram?: string[];
  tiktok?: string[];
  youtube?: string[];
}

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
  error?: string;
}

export function fullText(c?: PlatformCaption): string {
  if (!c) return "";
  const tags = (c.hashtags || []).map((h) => `#${h}`).join(" ");
  return [c.caption, tags].filter(Boolean).join("\n\n");
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
    return { url: saved.url || `${APP_URL}/api/media/${saved.id}`, type };
  }
  return undefined;
}

/**
 * Kern-publiceerfunctie — gedeeld door de directe "Post nu" én de cron-scheduler.
 * `mediaUrl` is al een PUBLIEKE url (geen data-URL). dryRun controleert alleen
 * de koppeling zonder echt te posten.
 */
export async function publishForAccount(opts: {
  accountId: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  targets: PublishTargets;
  captions: PublishCaptions;
  dryRun?: boolean;
}): Promise<{ ok: boolean; results: PublishResult[]; error?: string }> {
  const { accountId, mediaUrl, targets, captions, dryRun } = opts;
  const isImage = opts.mediaType === "image";
  const media = mediaUrl
    ? { url: mediaUrl, kind: (isImage ? "image" : "video") as "image" | "video" }
    : undefined;

  const store = await loadMetaStore(accountId);
  const igConn = await loadIgConnection(accountId);
  const ttConn = await loadTikTokConnection(accountId);
  const ytConn = await loadYouTubeConnection(accountId);
  const page = activePage(store);

  if (!page && !igConn && !ttConn && !ytConn) {
    return { ok: false, results: [], error: "Dit account is nog niet verbonden" };
  }

  const results: PublishResult[] = [];
  const dry = (platform: string, placement: string, need?: string) =>
    results.push({
      platform,
      placement,
      ok: !need,
      id: need ? undefined : "dry-run",
      error: need,
    });

  // ---------- Facebook ----------
  for (const placement of targets.facebook || []) {
    try {
      if (!page) throw new Error("Geen Facebook-pagina verbonden");
      if (placement !== "feed")
        throw new Error("Facebook-stories via API komen later");
      if (dryRun) {
        dry("facebook", placement);
        continue;
      }
      const r = await postToFacebookPage(page, fullText(captions.facebook), media);
      results.push({ platform: "facebook", placement, ok: true, id: r.id });
    } catch (e) {
      results.push({
        platform: "facebook",
        placement,
        ok: false,
        error: e instanceof Error ? e.message : "mislukt",
      });
    }
  }

  // ---------- Instagram ----------
  const igId = page?.instagram?.id;
  for (const placement of targets.instagram || []) {
    try {
      if (!igConn && !igId) throw new Error("Geen Instagram-account gekoppeld");
      if (!media) throw new Error("Instagram heeft een foto of video nodig");
      if (dryRun) {
        dry("instagram", placement);
        continue;
      }
      const caption = fullText(captions.instagram);
      const plc = placement === "story" ? "story" : "feed";
      const r = igConn
        ? await postToInstagramDirect(igConn, media, caption, plc)
        : await postToInstagram(igId!, page!.accessToken, media, caption, plc);
      results.push({ platform: "instagram", placement, ok: true, id: r.id });
    } catch (e) {
      results.push({
        platform: "instagram",
        placement,
        ok: false,
        error: e instanceof Error ? e.message : "mislukt",
      });
    }
  }

  // ---------- TikTok ----------
  for (const placement of targets.tiktok || []) {
    try {
      if (!ttConn) throw new Error("Geen TikTok-account gekoppeld");
      if (!mediaUrl || isImage) throw new Error("TikTok heeft een video nodig");
      if (dryRun) {
        dry("tiktok", placement);
        continue;
      }
      const r = await postToTikTok(ttConn, mediaUrl, fullText(captions.tiktok));
      results.push({ platform: "tiktok", placement, ok: true, id: r.id });
    } catch (e) {
      results.push({
        platform: "tiktok",
        placement,
        ok: false,
        error: e instanceof Error ? e.message : "mislukt",
      });
    }
  }

  // ---------- YouTube (Shorts) ----------
  for (const placement of targets.youtube || []) {
    try {
      if (!ytConn) throw new Error("Geen YouTube-kanaal gekoppeld");
      if (!mediaUrl || isImage) throw new Error("YouTube heeft een video nodig");
      if (dryRun) {
        dry("youtube", placement);
        continue;
      }
      const c = captions.youtube;
      const r = await postToYouTube(
        ytConn,
        mediaUrl,
        c?.title || c?.caption?.slice(0, 90) || "Nieuwe video",
        fullText(c),
      );
      results.push({ platform: "youtube", placement, ok: true, id: r.id });
    } catch (e) {
      results.push({
        platform: "youtube",
        placement,
        ok: false,
        error: e instanceof Error ? e.message : "mislukt",
      });
    }
  }

  return { ok: results.some((r) => r.ok), results };
}
