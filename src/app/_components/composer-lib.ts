/**
 * Types en pure helpers voor de composer (client-veilig, geen JSX).
 */
import { PLATFORMS, PLATFORM_MAP, type PlatformId } from "@/lib/platforms";
import type { DroppedTarget, PublishTargets } from "@/lib/targets";
import type { AccountInfo, MediaKind } from "@/lib/types";

export interface MediaItem {
  /** blob:-URL voor de preview (nooit naar de server sturen) */
  previewUrl: string;
  /** publieke URL na een geslaagde upload (Blob of /api/media) */
  url: string | null;
  type: MediaKind;
  mime: string;
  name: string;
  width?: number;
  height?: number;
  /** seconden (alleen video) */
  duration?: number;
  /** 0–100 */
  progress: number;
  error: string | null;
}

/** Resultaat per plaatsing zoals /api/publish en /api/history/retry het teruggeven. */
export interface ClientResult {
  platform: string;
  placement: string;
  ok: boolean;
  id?: string;
  url?: string;
  note?: string;
  error?: string;
}

export interface PublishResponse {
  ok?: boolean;
  allOk?: boolean;
  results?: ClientResult[];
  dropped?: DroppedTarget[];
  error?: string;
  historyId?: string;
}

export type { AccountInfo, DroppedTarget, PublishTargets };

export const LS_ACCOUNT_KEY = "socialflow.accountId";

/** Kanaalvolgorde in de UI. */
export const CHANNEL_ORDER: PlatformId[] = PLATFORMS.map((p) => p.id);

/**
 * Actieve Facebook-pagina van het account. De server geeft in selectedPageId
 * de pagina waarmee echt gepost wordt (null = er moet nog een gekozen worden).
 */
function activePageOf(acc?: AccountInfo) {
  if (!acc?.pages?.length) return undefined;
  return (
    acc.pages.find((p) => p.id === acc.selectedPageId) ??
    (acc.pages.length === 1 ? acc.pages[0] : undefined)
  );
}

export function isConnected(acc: AccountInfo | undefined, pid: PlatformId): boolean {
  if (!acc) return false;
  switch (pid) {
    case "facebook":
      return Boolean(acc.facebook);
    case "instagram":
      return Boolean(acc.instagram || acc.igLogin);
    case "tiktok":
      return Boolean(acc.tiktok);
    case "youtube":
      return Boolean(acc.youtube);
  }
}

export function connectedChannels(acc?: AccountInfo): PlatformId[] {
  return CHANNEL_ORDER.filter((p) => isConnected(acc, p));
}

/** Echte naam/handle per kanaal (pagina-naam, @username, kanaalnaam) of null. */
export function channelHandle(acc: AccountInfo | undefined, pid: PlatformId): string | null {
  if (!acc) return null;
  switch (pid) {
    case "facebook":
      return acc.facebook ? activePageOf(acc)?.name ?? null : null;
    case "instagram": {
      const u = acc.igLogin?.username || (acc.instagram ? activePageOf(acc)?.instagram : null);
      return u ? `@${u.replace(/^@/, "")}` : null;
    }
    case "tiktok":
      return acc.tiktok?.displayName || null;
    case "youtube":
      return acc.youtube?.channelTitle || null;
  }
}

/** Naam zoals de preview 'm toont (zonder @), met fallback. */
export function previewName(acc: AccountInfo | undefined, pid: PlatformId): string {
  const h = channelHandle(acc, pid);
  if (!h) return "jouw_account";
  return pid === "instagram" ? h.replace(/^@/, "") : h;
}

export function platformName(id: string): string {
  return PLATFORM_MAP[id as PlatformId]?.name ?? id;
}

const PLACEMENT_NL: Record<string, string> = {
  feed: "Post",
  reel: "Reel",
  story: "Story",
  short: "Short",
  video: "Video",
};

export function placementName(platform: string, placement: string): string {
  if (platform === "tiktok" && placement === "feed") return "Video";
  if (platform === "instagram" && placement === "feed") return "Feed";
  return PLACEMENT_NL[placement] ?? placement;
}

/** Lijst van { platform, placement } in UI-volgorde. */
export function targetList(t: PublishTargets): { platform: PlatformId; placement: string }[] {
  const out: { platform: PlatformId; placement: string }[] = [];
  for (const pid of CHANNEL_ORDER) {
    for (const plc of t[pid] || []) out.push({ platform: pid, placement: plc });
  }
  return out;
}

/** Targets met alleen de geslaagde resultaten. */
export function targetsFromResults(results: ClientResult[]): PublishTargets {
  const out: Record<string, string[]> = {};
  for (const r of results) {
    if (!r.ok) continue;
    const list = (out[r.platform] ||= []);
    if (!list.includes(r.placement)) list.push(r.placement);
  }
  return out as PublishTargets;
}

/* ---------------- Koppelingsgezondheid (T7) ---------------- */

export interface HealthWarning {
  platform: string;
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const HEALTH_WARN_DAYS = 10;

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // seconden-epoch → ms
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Waarschuwingen voor het account: status 'needs_reauth' of een verloopdatum
 * binnen 10 dagen. Accepteert `health` als object per kanaal
 * ({ facebook: { status, expiresAt } }) of als array ([{ platform, status, expiresAt }]).
 * Geen (bruikbaar) health-veld → lege lijst.
 */
export function healthWarnings(acc: AccountInfo | undefined, now: number): HealthWarning[] {
  // Tolerant lezen: oudere/andere vormen mogen geen crash geven.
  const h: unknown = acc?.health;
  if (!h || typeof h !== "object") return [];
  const entries: [string, unknown][] = Array.isArray(h)
    ? h.map((x) => [
        x && typeof x === "object" && typeof (x as { platform?: unknown }).platform === "string"
          ? (x as { platform: string }).platform
          : "",
        x,
      ])
    : Object.entries(h as Record<string, unknown>);

  const out: HealthWarning[] = [];
  for (const [key, raw] of entries) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as { status?: unknown; expiresAt?: unknown; platform?: unknown };
    const platform = key || (typeof v.platform === "string" ? v.platform : "");
    const name = platform ? platformName(platform) : "Koppeling";
    if (v.status === "needs_reauth") {
      out.push({ platform, text: `${name}: opnieuw koppelen nodig` });
      continue;
    }
    const exp = toMs(v.expiresAt);
    if (exp !== null && exp - now < HEALTH_WARN_DAYS * DAY_MS) {
      const days = Math.ceil((exp - now) / DAY_MS);
      out.push({
        platform,
        text:
          days <= 0
            ? `${name}: koppeling is verlopen`
            : `${name}: koppeling verloopt over ${days} ${days === 1 ? "dag" : "dagen"}`,
      });
    }
  }
  return out;
}

/** Huidige lokale tijd in het formaat van <input type="datetime-local">. */
export function localDateTimeMin(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString("nl-NL", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
