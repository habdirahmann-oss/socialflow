import { kvGet, kvSet, withLock } from "./store";
import {
  publishForAccount,
  type PublishTargets,
  type PublishCaptions,
  type PublishResult,
} from "./publish";
import { normalizeTargets } from "./targets";
import type { PlacementId } from "./platforms";
import type { MediaKind } from "./types";

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
  /** Carrousel: alle foto-URL's op volgorde (mediaUrl = de eerste). */
  mediaUrls?: string[];
  mediaType?: MediaKind;
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
/**
 * Een 'processing'-post die langer dan dit vastzit, is onderbroken (bv. een
 * function-timeout). Hij wordt dan NIET blind opnieuw verstuurd, maar op
 * 'onbekend, controleer het kanaal' gezet (zie markInterrupted).
 */
export const STALE_PROCESSING_MS = 10 * 60_000;

/** Resultaat voor een plaatsing waarvan we niet weten of hij online staat. */
export const INTERRUPTED_RESULT_ERROR =
  "Onbekend: het plaatsen werd onderbroken (time-out). Controleer het kanaal voordat je opnieuw probeert — de post kan al online staan.";
export const INTERRUPTED_ERROR =
  "Plaatsen werd onderbroken (time-out). Controleer de kanalen met 'onbekend' voordat je 'Opnieuw proberen' kiest.";
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
  return (await removeScheduledPost(id, now)).result;
}

type RemoveResult = {
  result: "removed" | "processing" | "notfound";
  post?: ScheduledPost;
};

/** Zoals removeScheduled, maar geeft ook de verwijderde post terug (voor opruimen van media). */
export async function removeScheduledPost(
  id: string,
  now: number = Date.now(),
): Promise<RemoveResult> {
  return mutate<RemoveResult>((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: { result: "notfound" as const } };
    const p = all[idx];
    if (p.status === "processing" && !isStaleProcessing(p, now)) {
      return { save: false, result: { result: "processing" as const, post: p } };
    }
    all.splice(idx, 1);
    return { save: true, result: { result: "removed" as const, post: p } };
  });
}

/** Aantal posts per account dat nog wacht ('pending'). */
export async function pendingCountByAccount(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const p of await readAll()) {
    if (p.status === "pending") out[p.accountId] = (out[p.accountId] || 0) + 1;
  }
  return out;
}

/**
 * Annuleert (verwijdert) alle wachtende posts van een account, bv. bij het
 * verwijderen van dat account. Posts die nu geplaatst worden en de
 * geschiedenis blijven staan. Geeft de verwijderde posts terug.
 */
export async function cancelPendingForAccount(accountId: string): Promise<ScheduledPost[]> {
  return mutate<ScheduledPost[]>((all) => {
    const removed = all.filter((p) => p.accountId === accountId && p.status === "pending");
    if (!removed.length) return { save: false, result: [] };
    const keep = all.filter((p) => !(p.accountId === accountId && p.status === "pending"));
    all.splice(0, all.length, ...keep);
    return { save: true, result: removed };
  });
}

export interface ScheduledPatch {
  scheduledFor?: number;
  captions?: PublishCaptions;
  targets?: PublishTargets;
}

export type GuardedResult =
  | { kind: "ok"; post: ScheduledPost }
  | { kind: "notfound" }
  | { kind: "conflict"; status: ScheduledStatus };

/**
 * Past een post aan — alleen zolang hij 'pending' is. Een post die bezig of
 * afgerond is → conflict (409). Een nieuw tijdstip wist een geplande herkansing.
 */
export async function patchScheduled(
  id: string,
  patch: ScheduledPatch,
  now: number = Date.now(),
): Promise<GuardedResult> {
  return mutate<GuardedResult>((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: { kind: "notfound" } };
    const p = all[idx];
    if (p.status !== "pending") {
      return { save: false, result: { kind: "conflict", status: p.status } };
    }
    const next: ScheduledPost = { ...p, updatedAt: now };
    if (patch.scheduledFor !== undefined) {
      next.scheduledFor = patch.scheduledFor;
      next.nextAttemptAt = undefined;
    }
    if (patch.captions !== undefined) next.captions = patch.captions;
    if (patch.targets !== undefined) next.targets = patch.targets;
    all[idx] = next;
    return { save: true, result: { kind: "ok", post: next } };
  });
}

/**
 * Zet een post klaar voor directe verwerking door processPost:
 * - 'post-now' (alleen 'pending'): tijdstip = nu, geen wachttijd.
 * - 'retry' (alleen 'failed'/'partial'): pogingen terug naar 0, weer 'pending'.
 * Bij processPost worden daarna alleen de doelen zonder ok-resultaat verstuurd.
 */
export async function prepareScheduledAction(
  id: string,
  action: "post-now" | "retry",
  now: number = Date.now(),
): Promise<GuardedResult> {
  return mutate<GuardedResult>((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: { kind: "notfound" } };
    const p = all[idx];
    const allowed =
      action === "post-now"
        ? p.status === "pending"
        : p.status === "failed" || p.status === "partial";
    if (!allowed) {
      return { save: false, result: { kind: "conflict", status: p.status } };
    }
    const next: ScheduledPost = {
      ...p,
      scheduledFor: now,
      nextAttemptAt: 0,
      updatedAt: now,
    };
    if (action === "retry") {
      next.attempts = 0;
      next.status = "pending";
    }
    all[idx] = next;
    return { save: true, result: { kind: "ok", post: next } };
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
 * Een vastgelopen 'processing'-post afronden zonder opnieuw te versturen:
 * tussentijds opgeslagen ok-resultaten blijven staan, de rest wordt
 * 'onbekend' (ok:false). Daarna is hij 'partial' of 'failed' en kan de
 * gebruiker na controle zelf 'Opnieuw proberen' kiezen.
 */
function markInterrupted(p: ScheduledPost, now: number): ScheduledPost {
  const merged = new Map<string, PublishResult>();
  for (const r of p.results || []) {
    if (r.platform === "-") continue;
    merged.set(resultKey(r), r);
  }
  for (const t of targetPairs(effectiveTargets(p))) {
    const key = resultKey(t);
    if (merged.get(key)?.ok) continue;
    merged.set(key, {
      platform: t.platform as PublishResult["platform"],
      placement: t.placement,
      ok: false,
      error: INTERRUPTED_RESULT_ERROR,
    });
  }
  const results = [...merged.values()];
  return {
    ...p,
    results,
    status: results.some((r) => r.ok) ? "partial" : "failed",
    processingAt: undefined,
    nextAttemptAt: undefined,
    lastError: INTERRUPTED_ERROR,
    updatedAt: now,
  };
}

export type ClaimResult =
  | { kind: "claimed"; post: ScheduledPost }
  | { kind: "interrupted"; post: ScheduledPost };

/**
 * Claimt een post atomisch (onder lock, na opnieuw lezen). Geeft de geclaimde
 * post terug, of null als hij al door een ander is opgepakt, nog niet aan de
 * beurt is, of intussen geannuleerd is. Een vastgelopen 'processing'-post
 * wordt niet geclaimd maar als onderbroken afgerond ('interrupted').
 */
export async function claimPost(
  id: string,
  now: number,
): Promise<ClaimResult | null> {
  return mutate<ClaimResult | null>((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return { save: false, result: null };
    const p = all[idx];
    if (!isDue(p, now)) return { save: false, result: null };
    if (p.status === "processing") {
      all[idx] = markInterrupted(p, now);
      return { save: true, result: { kind: "interrupted", post: all[idx] } };
    }
    all[idx] = {
      ...p,
      status: "processing",
      processingAt: now,
      attempts: (p.attempts ?? 0) + 1,
      updatedAt: now,
    };
    return { save: true, result: { kind: "claimed", post: all[idx] } };
  });
}

/**
 * Slaat een geslaagde plaatsing tussentijds op bij een post die nog
 * 'processing' is. Breekt de function daarna af, dan weten we wat al online
 * staat en wordt dat nooit opnieuw verstuurd.
 */
export async function recordResult(id: string, r: PublishResult): Promise<void> {
  if (!r.ok) return;
  await mutate((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0 || all[idx].status !== "processing") return { save: false, result: null };
    const p = all[idx];
    const results = (p.results || []).filter((x) => resultKey(x) !== resultKey(r));
    results.push(r);
    all[idx] = { ...p, results };
    return { save: true, result: null };
  });
}

export const resultKey = (r: { platform: string; placement: string }) =>
  `${r.platform}:${r.placement}`;

export function targetPairs(
  targets: PublishTargets,
): { platform: string; placement: PlacementId }[] {
  const out: { platform: string; placement: PlacementId }[] = [];
  for (const [platform, placements] of Object.entries(targets || {})) {
    for (const placement of (placements as PlacementId[] | undefined) || []) {
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
export function effectiveTargets(
  post: Pick<ScheduledPost, "targets" | "mediaUrl" | "mediaType">,
): PublishTargets {
  const kind = post.mediaUrl
    ? post.mediaType === "image"
      ? "image"
      : "video"
    : undefined;
  return normalizeTargets(post.targets, kind).targets;
}

/** Doelen zonder geslaagd resultaat — alleen die worden (opnieuw) verstuurd. */
export function remainingTargets(
  post: Pick<ScheduledPost, "targets" | "mediaUrl" | "mediaType" | "results">,
): PublishTargets {
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

export function countTargets(t: PublishTargets): number {
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
 * Voegt de uitkomst van een poging samen met eerdere resultaten (per
 * `${platform}:${placement}`, laatste wint) en bepaalt of alles/iets gelukt is.
 * Gedeeld door de scheduler en de post-geschiedenis.
 */
export function mergeOutcome(
  p: Pick<ScheduledPost, "results" | "targets" | "mediaUrl" | "mediaType">,
  out: { results?: PublishResult[]; error?: string },
): { results: PublishResult[]; allOk: boolean; anyOk: boolean; failMsg: string } {
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
  const failMsg =
    out.error ||
    (out.results || []).find((r) => !r.ok)?.error ||
    results.find((r) => !r.ok)?.error ||
    "Onbekende fout";
  return { results, allOk, anyOk, failMsg };
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

    const { results, allOk, anyOk, failMsg } = mergeOutcome(p, out);
    const attempts = Math.max(1, p.attempts ?? 1);

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
  opts: { deadline?: number } = {},
): Promise<ScheduledPost | null> {
  const claim = await claimPost(id, now);
  if (!claim) return null;
  if (claim.kind === "interrupted") return claim.post;
  const post = claim.post;

  const targets = remainingTargets(post);
  let out: { results?: PublishResult[]; error?: string };
  if (countTargets(targets) === 0) {
    out = { results: [] };
  } else {
    try {
      out = await publishForAccount({
        accountId: post.accountId,
        mediaUrl: post.mediaUrl,
        mediaUrls: post.mediaUrls,
        mediaType: post.mediaType,
        targets,
        captions: post.captions,
        dryRun: post.dryRun,
        deadline: opts.deadline,
        // Elke geslaagde plaatsing meteen opslaan (zie recordResult).
        onResult: post.dryRun ? undefined : (r) => recordResult(id, r),
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
