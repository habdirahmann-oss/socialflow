import type { ScheduledPost, ScheduledStatus } from "./schedule";
import type { PublishCaptions } from "./publish";
import { parseTikTokSettings } from "./tiktok-settings";

/**
 * Gedeelde API-weergave voor ingeplande posts én geschiedenis-entries
 * (Planning-pagina en composer).
 */
export function postView(p: ScheduledPost & { source?: "direct" }) {
  return {
    id: p.id,
    source: p.source === "direct" ? ("direct" as const) : ("scheduled" as const),
    accountId: p.accountId,
    accountName: p.accountName,
    scheduledFor: p.scheduledFor,
    mediaUrl: p.mediaUrl,
    mediaType: p.mediaType,
    thumb: p.thumb,
    subject: p.subject,
    targets: p.targets,
    captions: p.captions,
    status: p.status,
    attempts: p.attempts,
    nextAttemptAt: p.nextAttemptAt,
    processingAt: p.processingAt,
    results: p.results,
    dryRun: p.dryRun,
    lastError: p.lastError,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export type PostView = ReturnType<typeof postView>;

const STATUSES: ScheduledStatus[] = [
  "pending",
  "processing",
  "posted",
  "partial",
  "failed",
];

/** `?status=pending,processing` → Set; leeg/ongeldig → null (geen filter). */
export function parseStatusFilter(raw: string | null): Set<ScheduledStatus> | null {
  if (!raw) return null;
  const set = new Set<ScheduledStatus>();
  for (const s of raw.split(",")) {
    const v = s.trim() as ScheduledStatus;
    if (STATUSES.includes(v)) set.add(v);
  }
  return set.size ? set : null;
}

const CAPTION_PLATFORMS = new Set(["facebook", "instagram", "tiktok", "youtube"]);
const MAX_CAPTION = 10_000;

/**
 * Valideert captions: { platform: { caption, story?, title?, hashtags? } }.
 * Onbekende kanalen worden genegeerd; null bij een ongeldige vorm.
 */
export function parseCaptions(v: unknown): PublishCaptions | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!CAPTION_PLATFORMS.has(k)) continue; // onbekende kanalen negeren
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    const c = raw as Record<string, unknown>;
    const str = (x: unknown) =>
      typeof x === "string" ? x.slice(0, MAX_CAPTION) : undefined;
    if (c.caption !== undefined && typeof c.caption !== "string") return null;
    const hashtags = Array.isArray(c.hashtags)
      ? c.hashtags
          .filter((h): h is string => typeof h === "string")
          .map((h) => h.replace(/^#+/, "").trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];
    out[k] = {
      caption: str(c.caption) ?? "",
      story: str(c.story) ?? "",
      ...(typeof c.title === "string" ? { title: str(c.title) } : {}),
      hashtags,
      ...(k === "tiktok" && parseTikTokSettings(c.tiktok)
        ? { tiktok: parseTikTokSettings(c.tiktok) }
        : {}),
    };
  }
  return out as PublishCaptions;
}
