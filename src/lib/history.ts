import type { MediaKind } from "./types";
import { kvGet, kvSet, withLock } from "./store";
import {
  publishForAccount,
  type PublishCaptions,
  type PublishOutcome,
  type PublishResult,
  type PublishTargets,
} from "./publish";
import {
  mergeOutcome,
  remainingTargets,
  countTargets,
  type ScheduledPost,
} from "./schedule";

/**
 * Server-side geschiedenis van direct ('Post nu') geplaatste posts.
 *
 * Zelfde vorm als een ingeplande post (zie schedule.ts) + `source: 'direct'`.
 * Vóór het publiceren wordt een entry met status 'processing' geschreven en
 * daarna bijgewerkt. Loopt de functie in een time-out, dan blijft de entry
 * zichtbaar als 'processing' ("Bezig / onbekend — controleer het kanaal"),
 * zodat niemand blind opnieuw post.
 */

export type HistoryEntry = ScheduledPost & { source: "direct" };

const KEY = "post-history";
const LOCK = "lock:post-history";
/** Maximaal aantal entries (nieuwste eerst). */
export const MAX_HISTORY = 200;

function normalize(e: HistoryEntry): HistoryEntry {
  return {
    ...e,
    source: "direct",
    status: e.status ?? "processing",
    attempts: e.attempts ?? 1,
    results: Array.isArray(e.results) ? e.results : [],
    targets: e.targets ?? {},
    captions: e.captions ?? {},
  };
}

async function readAll(): Promise<HistoryEntry[]> {
  const raw = (await kvGet<HistoryEntry[]>(KEY)) ?? [];
  return Array.isArray(raw) ? raw.map(normalize) : [];
}

/** Read-modify-write onder lock. Elke schrijfactie gaat hierlangs. */
async function mutate<T>(
  fn: (all: HistoryEntry[]) => { save: boolean; result: T },
): Promise<T> {
  return withLock(LOCK, async () => {
    const all = await readAll();
    const { save, result } = fn(all);
    if (save) await kvSet(KEY, all.slice(0, MAX_HISTORY));
    return result;
  });
}

/** Alle entries, nieuwste eerst. */
export async function listHistory(): Promise<HistoryEntry[]> {
  return readAll();
}

/** Nieuwe entry vooraan; de lijst wordt afgekapt op MAX_HISTORY. */
export async function addHistory(entry: HistoryEntry): Promise<HistoryEntry> {
  return mutate((all) => {
    const fresh = normalize(entry);
    const rest = all.filter((e) => e.id !== fresh.id);
    all.splice(0, all.length, fresh, ...rest);
    return { save: true, result: fresh };
  });
}

/**
 * Rondt een poging af: resultaten samenvoegen (laatste wint) en status
 * bepalen met dezelfde regels als de scheduler na de laatste poging:
 * alles gelukt → posted, iets gelukt → partial, niets → failed.
 */
export async function finishHistory(
  id: string,
  out: { results?: PublishResult[]; error?: string },
  now: number = Date.now(),
): Promise<HistoryEntry | null> {
  return mutate((all) => {
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return { save: false, result: null };
    const e = all[idx];
    const { results, allOk, anyOk, failMsg } = mergeOutcome(e, out);
    const next: HistoryEntry = {
      ...e,
      results,
      status: allOk ? "posted" : anyOk ? "partial" : "failed",
      lastError: allOk ? undefined : failMsg,
      processingAt: undefined,
      updatedAt: now,
    };
    all[idx] = next;
    return { save: true, result: next };
  });
}

/** Afronden mag niet stranden op een drukke lock (anders blijft 'processing' staan). */
async function finishWithRetry(
  id: string,
  out: { results?: PublishResult[]; error?: string },
): Promise<HistoryEntry | null> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await finishHistory(id, out);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export type HistoryClaim =
  | { kind: "ok"; entry: HistoryEntry }
  | { kind: "notfound" }
  | { kind: "conflict"; error: string };

/**
 * Claimt een entry voor 'Opnieuw proberen' (onder lock). Een entry die nog
 * 'processing' is mag niet: misschien is hij wél geplaatst.
 */
export async function claimHistoryRetry(
  id: string,
  now: number = Date.now(),
): Promise<HistoryClaim> {
  return mutate<HistoryClaim>((all) => {
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return { save: false, result: { kind: "notfound" } };
    const e = all[idx];
    if (e.status === "processing") {
      return {
        save: false,
        result: {
          kind: "conflict",
          error: "Deze post is nog bezig of de status is onbekend — controleer eerst het kanaal",
        },
      };
    }
    if (e.status !== "failed" && e.status !== "partial") {
      return {
        save: false,
        result: { kind: "conflict", error: "Deze post is al volledig geplaatst" },
      };
    }
    const next: HistoryEntry = {
      ...e,
      status: "processing",
      processingAt: now,
      attempts: (e.attempts ?? 1) + 1,
      updatedAt: now,
    };
    all[idx] = next;
    return { save: true, result: { kind: "ok", entry: next } };
  });
}

/** Publiceert alleen de doelen van een entry die nog geen ok-resultaat hebben. */
async function publishRemaining(
  e: HistoryEntry,
): Promise<{ results?: PublishResult[]; error?: string }> {
  const targets = remainingTargets(e);
  if (countTargets(targets) === 0) return { results: [] };
  try {
    const out = await publishForAccount({
      accountId: e.accountId,
      mediaUrl: e.mediaUrl,
      mediaType: e.mediaType,
      mediaUrls: e.mediaUrls,
      targets,
      captions: e.captions,
      dryRun: e.dryRun,
    });
    return { results: out.results, error: out.error };
  } catch (err) {
    return {
      results: [],
      error: err instanceof Error ? err.message : "Publiceren mislukt",
    };
  }
}

/** 'Opnieuw proberen' voor een directe post: claim → alleen mislukte doelen → samenvoegen. */
export async function retryHistory(
  id: string,
): Promise<HistoryClaim> {
  const claim = await claimHistoryRetry(id);
  if (claim.kind !== "ok") return claim;
  const out = await publishRemaining(claim.entry);
  const done = await finishWithRetry(id, out);
  return done ? { kind: "ok", entry: done } : { kind: "notfound" };
}

export interface DirectPublishInput {
  id: string;
  accountId: string;
  accountName: string;
  subject: string;
  mediaUrl?: string;
  mediaType?: MediaKind;
  /** Carrousel: alle foto-URL's. */
  mediaUrls?: string[];
  /** Al genormaliseerd (alleen wat met deze media kan). */
  targets: PublishTargets;
  /** Zoals de client ze stuurde (voor publishForAccount). */
  requestedTargets: PublishTargets;
  captions: PublishCaptions;
  dryRun: boolean;
}

/**
 * Directe publicatie mét geschiedenis:
 * 1. entry 'processing' schrijven (mislukt dit → er wordt NIET gepubliceerd),
 * 2. publiceren,
 * 3. entry bijwerken met resultaten + eindstatus.
 * `publish` is injecteerbaar voor tests.
 */
export async function publishDirectWithHistory(
  input: DirectPublishInput,
  publish: typeof publishForAccount = publishForAccount,
): Promise<{ out: PublishOutcome; entry: HistoryEntry | null }> {
  const now = Date.now();
  await addHistory({
    id: input.id,
    source: "direct",
    accountId: input.accountId,
    accountName: input.accountName,
    scheduledFor: now,
    mediaUrl: input.mediaUrl,
    mediaType: input.mediaType,
    ...(input.mediaUrls ? { mediaUrls: input.mediaUrls } : {}),
    thumb:
      input.mediaType === "image" && /^https?:/.test(input.mediaUrl || "")
        ? input.mediaUrl
        : undefined,
    subject: input.subject,
    targets: input.targets,
    captions: input.captions,
    status: "processing",
    processingAt: now,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  let out: PublishOutcome;
  try {
    out = await publish({
      accountId: input.accountId,
      mediaUrl: input.mediaUrl,
      mediaType: input.mediaType,
      mediaUrls: input.mediaUrls,
      targets: input.requestedTargets,
      captions: input.captions,
      dryRun: input.dryRun,
    });
  } catch (e) {
    out = {
      ok: false,
      allOk: false,
      results: [],
      dropped: [],
      error: e instanceof Error ? e.message : "Publiceren mislukt",
    };
  }

  let entry: HistoryEntry | null = null;
  try {
    entry = await finishWithRetry(input.id, { results: out.results, error: out.error });
  } catch {
    // De entry blijft 'processing' → UI toont "controleer het kanaal".
  }
  return { out, entry };
}

/** Wordt deze media-URL nog door een entry gebruikt? */
export async function historyReferencesMedia(url: string): Promise<boolean> {
  return (await readAll()).some((e) => e.mediaUrl === url);
}
