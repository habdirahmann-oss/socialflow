import { kvGet, kvSet, withLock } from "./store";
import {
  publishForAccount,
  type PublishTargets,
  type PublishCaptions,
  type PublishResult,
} from "./publish";
import { normalizeTargets } from "./targets";

export type ScheduledStatus =
  | "pending" // wacht op tijdstip (of op een volgende poging)
  | "processing" // wordt nu geplaatst door de cron
  | "posted" // alle kanalen gelukt
  | "partial" // na de laatste poging: deels gelukt
  | "failed"; // na de laatste poging: niets gelukt

export interface ScheduledPost {
  id: string;
  accountId: string;
  accountName: string;
  scheduledFor: number; // epoch ms
  mediaUrl?: string; // al publiek (Blob)
  mediaType?: "image" | "video";
  thumb?: string; // kleine preview-url
  subject: string;
  targets: PublishTargets;
  captions: PublishCaptions;
  status: ScheduledStatus;
  /** Cumulatief per `${platform}:${placement}`; de laatste poging wint. */
  results?: PublishResult[];
  createdAt: number;
  processingAt?: number;
  attempts?: number;
  nextAttemptAt?: number;
  updatedAt?: number;
  lastError?: string;
  dryRun?: boolean;
}

const KEY = "scheduled-posts";
const LOCK = "lock:scheduled-posts";

export const MAX_ATTEMPTS = 3;
/** Een 'processing'-post die langer dan dit vastzit, mag opnieuw opgepakt worden. */
export const STALE_PROCESSING_MS = 10 * 60_000;
/** Wachttijd vóór poging 2 en 3. */
const RETRY_DELAYS_MIN = [5, 15];
/** Zoveel afgeronde posts bewaren we (nieuwste eerst). */
const KEEP_FINISHED = 300;

/** Oude records (zonder nieuwe velden) krijgen veilige standaardwaarden. */
function normalize(p: ScheduledPost): ScheduledPost {
  return {
    ...p,
    status: p.status ?? "pending",
    attempts: p.attempts ?? 0,
    results: Array.isArray(p.results) ? p.results : [],
    targets: p.targets ?? {},
    captions: p.captions ?? {},
  };
}

async function readAll(): Promise<ScheduledPost[]> {
  const raw = (await kvGet<ScheduledPost[]>(KEY)) ?? [];
  return Array.isArray(raw) ? raw.map(normalize) : [];
}

/** Read-modify-write onder lock. `fn` muteert `all` en zegt of er opgeslagen moet worden. */
async function mutate<T>(
  fn: (all: ScheduledPost[]) => { save: boolean; result: T },
): Promise<T> {
  return withLock(LOCK, async () => {
    const all = await readAll();
    const { save, result } = fn(all);
    if (save) await kvSet(KEY, all);
    return result;
  });
}

export async function listScheduled(): Promise<ScheduledPost[]> {
  return readAll();
}

export async function getScheduled(id: string): Promise<ScheduledPost | null> {
  return (await readAll()).find((p) => p.id === id) ?? null;
}

/**
 * Voegt een post toe. Bestaat het id al (idempotente retry van de client),
 * dan wordt de bestaande post teruggegeven en niets dubbel aangemaakt.
 */
export async function addScheduled(
  post: ScheduledPost,
): Promise<{ post: ScheduledPost; created: boolean }> {
  return mutate<{ post: ScheduledPost; created: boolean }>((all) => {
    const existing = all.find((p) => p.id === post.id);
    if (existing) return { save: false, result: { post: existing, created: false } };
    const fresh = normalize({ ...post, updatedAt: post.updatedAt ?? Date.now() });
    all.push(fresh);
    return { save: true, result: { post: fresh, created: true } };
  });
}

export async function updateScheduled(
  id: string,
  patch: Partial<ScheduledPost>,
): Promise<ScheduledPost | null> {
  return mutate((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: null };
    all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() };
    return { save: true, result: all[idx] };
  });
}

export function isStaleProcessing(p: ScheduledPost, now: number): boolean {
  return (
    p.status === "processing" && (p.processingAt ?? 0) < now - STALE_PROCESSING_MS
  );
}

function isDue(p: ScheduledPost, now: number): boolean {
  if (p.status === "pending") {
    return p.scheduledFor <= now && (p.nextAttemptAt ?? 0) <= now;
  }
  return isStaleProcessing(p, now);
}

/**
 * Verwijdert een post. Een post die nu (niet-vastgelopen) geplaatst wordt,
 * mag niet verwijderd worden → 'processing'.
 */
export async function removeScheduled(
  id: string,
  now: number = Date.now(),
): Promise<"removed" | "processing" | "notfound"> {
  return mutate((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: "notfound" as const };
    const p = all[idx];
    if (p.status === "processing" && !isStaleProcessing(p, now)) {
      return { save: false, result: "processing" as const };
    }
    all.splice(idx, 1);
    return { save: true, result: "removed" as const };
  });
}

/** Posts die klaarstaan: pending + tijd verstreken, of vastgelopen 'processing'. */
export async function duePosts(now: number): Promise<ScheduledPost[]> {
  const all = await readAll();
  return all
    .filter((p) => isDue(p, now))
    .sort((a, b) => a.scheduledFor - b.scheduledFor);
}

/**
 * Claimt een post atomisch (onder lock, na opnieuw lezen). Geeft de geclaimde
 * post terug, of null als hij al door een ander is opgepakt, nog niet aan de
 * beurt is, of intussen geannuleerd is.
 */
export async function claimPost(
  id: string,
  now: number,
): Promise<ScheduledPost | null> {
  return mutate((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: null };
    const p = all[idx];
    if (!isDue(p, now)) return { save: false, result: null };
    all[idx] = {
      ...p,
      status: "processing",
      processingAt: now,
      attempts: (p.attempts ?? 0) + 1,
      updatedAt: now,
    };
    return { save: true, result: all[idx] };
  });
}

const resultKey = (r: { platform: string; placement: string }) =>
  `${r.platform}:${r.placement}`;

function targetPairs(targets: PublishTargets): { platform: string; placement: string }[] {
  const out: { platform: string; placement: string }[] = [];
  for (const [platform, placements] of Object.entries(targets || {})) {
    for (const placement of (placements as string[] | undefined) || []) {
      out.push({ platform, placement });
    }
  }
  return out;
}

/**
 * De plaatsingen die met de media van deze post echt kunnen (zie targets.ts).
 * Zo blijft een post niet eeuwig 'onvolledig' door bv. een Facebook-story of
 * een IG feed+reel die bij video samenvallen tot één reel.
 */
export function effectiveTargets(post: ScheduledPost): PublishTargets {
  const kind = post.mediaUrl
    ? post.mediaType === "image"
      ? "image"
      : "video"
    : undefined;
  return normalizeTargets(post.targets, kind).targets;
}

/** Doelen zonder geslaagd resultaat — alleen die worden (opnieuw) verstuurd. */
export function remainingTargets(post: ScheduledPost): PublishTargets {
  const done = new Set(
    (post.results || []).filter((r) => r.ok).map(resultKey),
  );
  const out: PublishTargets = {};
  for (const { platform, placement } of targetPairs(effectiveTargets(post))) {
    if (done.has(`${platform}:${placement}`)) continue;
    const key = platform as keyof PublishTargets;
    (out[key] ||= []).push(placement);
  }
  return out;
}

function countTargets(t: PublishTargets): number {
  return targetPairs(t).length;
}

/** Houdt alle open posts + de nieuwste afgeronde posts. */
function prune(all: ScheduledPost[]): ScheduledPost[] {
  const open = all.filter(
    (p) => p.status === "pending" || p.status === "processing",
  );
  const finished = all
    .filter((p) => p.status !== "pending" && p.status !== "processing")
    .sort(
      (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
    )
    .slice(0, KEEP_FINISHED);
  const keep = new Set([...open, ...finished].map((p) => p.id));
  return all.filter((p) => keep.has(p.id));
}

/**
 * Verwerkt de uitkomst van één poging: resultaten samenvoegen (laatste wint),
 * nieuwe status bepalen (posted / opnieuw pending / partial / failed) en opschonen.
 */
export async function finishPost(
  id: string,
  out: { results?: PublishResult[]; error?: string },
  now: number = Date.now(),
): Promise<ScheduledPost | null> {
  return mutate((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: null };
    const p = all[idx];

    const merged = new Map<string, PublishResult>();
    for (const r of p.results || []) {
      // Een oude algemene fout ('-:-') geldt alleen voor de poging waarin hij ontstond.
      if (r.platform === "-") continue;
      merged.set(resultKey(r), r);
    }
    for (const r of out.results || []) merged.set(resultKey(r), r);
    if (out.error) {
      merged.set("-:-", { platform: "-", placement: "-", ok: false, error: out.error });
    }
    const results = [...merged.values()];

    const pairs = targetPairs(effectiveTargets(p));
    const okKeys = new Set(results.filter((r) => r.ok).map(resultKey));
    const allOk = pairs.length > 0 && pairs.every((t) => okKeys.has(resultKey(t)));
    const anyOk = results.some((r) => r.ok);
    const attempts = Math.max(1, p.attempts ?? 1);
    const failMsg =
      out.error ||
      (out.results || []).find((r) => !r.ok)?.error ||
      results.find((r) => !r.ok)?.error ||
      "Onbekende fout";

    const next: ScheduledPost = {
      ...p,
      results,
      updatedAt: now,
      processingAt: undefined,
    };
    if (allOk) {
      next.status = "posted";
      next.nextAttemptAt = undefined;
      next.lastError = undefined;
    } else if (attempts < MAX_ATTEMPTS) {
      next.status = "pending";
      next.nextAttemptAt =
        now + RETRY_DELAYS_MIN[Math.min(attempts, RETRY_DELAYS_MIN.length) - 1] * 60_000;
      next.lastError = failMsg;
    } else {
      next.status = anyOk ? "partial" : "failed";
      next.nextAttemptAt = undefined;
      next.lastError = failMsg;
    }
    all[idx] = next;

    const pruned = prune(all);
    all.splice(0, all.length, ...pruned);
    return { save: true, result: next };
  });
}

/**
 * Claimt, publiceert (alleen nog niet gelukte doelen) en rondt af.
 * Gedeeld door de cron en andere triggers. Geeft null als de post niet
 * (meer) geclaimd kon worden.
 */
export async function processPost(
  id: string,
  now: number = Date.now(),
): Promise<ScheduledPost | null> {
  const post = await claimPost(id, now);
  if (!post) return null;

  const targets = remainingTargets(post);
  let out: { results?: PublishResult[]; error?: string };
  if (countTargets(targets) === 0) {
    out = { results: [] };
  } else {
    try {
      out = await publishForAccount({
        accountId: post.accountId,
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
        targets,
        captions: post.captions,
        dryRun: post.dryRun,
      });
    } catch (e) {
      out = {
        results: [],
        error: e instanceof Error ? e.message : "Publiceren mislukt",
      };
    }
  }
  // Afronden mag niet mislukken door een drukke lock: anders blijft de post
  // 'processing' en wordt hij na 10 min opnieuw (dubbel) verstuurd.
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await finishPost(id, out);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
