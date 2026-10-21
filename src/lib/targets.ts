/**
 * Plaatsing-normalisatie — puur en client-veilig (geen server-imports).
 *
 * Eén bron van waarheid voor "welke plaatsing kan met welke media": de server
 * gebruikt dit vóór het publiceren, de UI om te tonen wat overgeslagen wordt.
 */
import type { PlacementId, PlatformId } from "./platforms";
import type { MediaKind, PlatformCaption } from "./types";

export type { MediaKind };

export interface PublishTargets {
  facebook?: PlacementId[];
  instagram?: PlacementId[];
  tiktok?: PlacementId[];
  youtube?: PlacementId[];
}

export interface DroppedTarget {
  platform: string;
  placement: string;
  reason: string;
}

const PLATFORM_IDS: PlatformId[] = ["facebook", "instagram", "tiktok", "youtube"];

const REASON = {
  needsMedia: "heeft media nodig",
  needsVideo: "heeft een video nodig",
  videoOnly: "alleen video",
  unsupported: "nog niet ondersteund",
  unknownPlacement: "onbekende plaatsing",
  unknownPlatform: "onbekend kanaal",
  ytExclusive: "Short en Video sluiten elkaar uit",
} as const;

/** Volledige caption-tekst: caption + hashtags. */
export function fullText(c?: PlatformCaption): string {
  if (!c) return "";
  const tags = (c.hashtags || []).map((h) => `#${h}`).join(" ");
  return [c.caption, tags].filter(Boolean).join("\n\n");
}

/**
 * Waarom een kanaal met deze media niets kan plaatsen (voor de UI), of null.
 */
export function channelBlockReason(
  platform: PlatformId | string,
  mediaKind: MediaKind | undefined,
): string | null {
  switch (platform) {
    case "instagram":
      return mediaKind ? null : REASON.needsMedia;
    case "tiktok":
    case "youtube":
      if (!mediaKind) return REASON.needsVideo;
      if (mediaKind === "image") return REASON.videoOnly;
      return null;
    case "facebook":
      return null;
    default:
      return REASON.unknownPlatform;
  }
}

function uniqStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * Maakt van de gevraagde plaatsingen een set die met deze media echt kan.
 * - geen media: alleen Facebook-feed (tekst) blijft over
 * - foto: TikTok/YouTube vallen af; IG reel → feed
 * - video: IG feed + reel → één 'reel'
 * - YouTube: 'short' en 'video' sluiten elkaar uit (short wint)
 * - Facebook-/TikTok-story: nog niet ondersteund
 * - onbekende kanalen/plaatsingen vallen af
 */
export function normalizeTargets(
  targets: unknown,
  mediaKind: MediaKind | undefined,
): { targets: PublishTargets; dropped: DroppedTarget[] } {
  const out: PublishTargets = {};
  const dropped: DroppedTarget[] = [];
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    return { targets: out, dropped };
  }
  const drop = (platform: string, placement: string, reason: string) =>
    dropped.push({ platform, placement, reason });

  for (const [platform, raw] of Object.entries(targets as Record<string, unknown>)) {
    const list = uniqStrings(raw);
    if (!PLATFORM_IDS.includes(platform as PlatformId)) {
      for (const plc of list) drop(platform, plc, REASON.unknownPlatform);
      continue;
    }
    const keep: PlacementId[] = [];
    const add = (plc: PlacementId) => {
      if (!keep.includes(plc)) keep.push(plc);
    };

    switch (platform as PlatformId) {
      case "facebook":
        for (const plc of list) {
          if (plc === "feed") add("feed");
          else if (plc === "story") drop(platform, plc, REASON.unsupported);
          else drop(platform, plc, REASON.unknownPlacement);
        }
        break;

      case "instagram":
        for (const plc of list) {
          if (plc !== "feed" && plc !== "reel" && plc !== "story") {
            drop(platform, plc, REASON.unknownPlacement);
          } else if (!mediaKind) {
            drop(platform, plc, REASON.needsMedia);
          } else if (plc === "story") {
            add("story");
          } else {
            // foto → feed; video → reel (feed + reel worden één reel)
            add(mediaKind === "video" ? "reel" : "feed");
          }
        }
        break;

      case "tiktok":
        for (const plc of list) {
          if (plc === "story") drop(platform, plc, REASON.unsupported);
          else if (plc !== "feed") drop(platform, plc, REASON.unknownPlacement);
          else if (!mediaKind) drop(platform, plc, REASON.needsVideo);
          else if (mediaKind === "image") drop(platform, plc, REASON.videoOnly);
          else add("feed");
        }
        break;

      case "youtube": {
        // 'feed' is de oude id voor 'video' (bestaande ingeplande posts).
        const wanted: string[] = [];
        for (const plc of list) {
          const id = plc === "feed" ? "video" : plc;
          if (id !== "short" && id !== "video") {
            drop(platform, plc, REASON.unknownPlacement);
          } else if (!mediaKind) {
            drop(platform, plc, REASON.needsVideo);
          } else if (mediaKind === "image") {
            drop(platform, plc, REASON.videoOnly);
          } else if (!wanted.includes(id)) {
            wanted.push(id);
          }
        }
        if (wanted.length) {
          const pick = wanted.includes("short") ? "short" : "video";
          add(pick);
          for (const w of wanted) {
            if (w !== pick) drop(platform, w, `${REASON.ytExclusive} — ${pick} gekozen`);
          }
        }
        break;
      }
    }
    if (keep.length) out[platform as keyof PublishTargets] = keep;
  }
  return { targets: out, dropped };
}

/** Aantal plaatsingen in een targets-object. */
export function countTargets(t: PublishTargets): number {
  return Object.values(t).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
}
