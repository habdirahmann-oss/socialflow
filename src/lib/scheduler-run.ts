import { randomUUID } from "crypto";
import { duePosts, processPost } from "./schedule";
import { kvSetNX, kvGet, kvDel, kvSet } from "./store";
import { runDailyTokenHealth } from "./token-health";

const RUN_LOCK = "lock:cron";
/** Langer dan maxDuration (300 s), zodat er nooit twee runs tegelijk lopen. */
const RUN_LOCK_TTL_SEC = 310;
/** Max aantal posts per run (video's kunnen lang duren). */
const MAX_POSTS_PER_RUN = 3;
/** Na deze tijd pakken we geen nieuwe post meer op (een video kan ~250 s duren). */
const PICK_WINDOW_MS = 45_000;
/** Uiterste tijdstip voor plaatsingen (maxDuration 300 s, rest = opslaan). */
const PUBLISH_DEADLINE_MS = 270_000;
/** Alleen nog de dagelijkse token-run starten als er zoveel tijd over is. */
const HEALTH_WINDOW_MS = 240_000;

export interface RunResult {
  ranAt: number;
  skipped?: "busy" | "nothing-due";
  processed: { id: string; status?: string; attempts?: number; error?: string }[];
}

/**
 * Verstuurt ingeplande posts waarvan de tijd verstreken is, onder één lock.
 * Gedeeld door de cron-route (GitHub/QStash) en de 'bij openen'-trigger.
 * `onlyIfDue`: eerst goedkoop kijken of er iets klaarstaat (geen lock, geen health-run).
 */
export async function runDuePosts(opts: { onlyIfDue?: boolean } = {}): Promise<RunResult> {
  const ranAt = Date.now();
  if (opts.onlyIfDue && (await duePosts(ranAt)).length === 0) {
    return { ranAt, skipped: "nothing-due", processed: [] };
  }
  const token = `${ranAt}-${randomUUID()}`;
  if (!(await kvSetNX(RUN_LOCK, token, RUN_LOCK_TTL_SEC))) {
    return { ranAt, skipped: "busy", processed: [] };
  }

  const processed: RunResult["processed"] = [];
  try {
    const tried = new Set<string>();
    while (processed.length < MAX_POSTS_PER_RUN && Date.now() - ranAt < PICK_WINDOW_MS) {
      const now = Date.now();
      const next = (await duePosts(now)).find((p) => !tried.has(p.id));
      if (!next) break;
      tried.add(next.id);
      try {
        const done = await processPost(next.id, now, { deadline: ranAt + PUBLISH_DEADLINE_MS });
        if (done) processed.push({ id: done.id, status: done.status, attempts: done.attempts });
      } catch (e) {
        processed.push({ id: next.id, error: e instanceof Error ? e.message : "cron-fout" });
      }
    }
    // Dagelijks (max. 1× per 24 u): IG-tokens verversen + token-controles. Posts gaan voor.
    let tokenHealth: { ranAt: number; accounts: number } | null = null;
    if (!opts.onlyIfDue && Date.now() - ranAt < HEALTH_WINDOW_MS) {
      tokenHealth = await runDailyTokenHealth().catch(() => null);
    }
    await kvSet("cron-last-run", { ranAt, processed, tokenHealth }).catch(() => {});
  } finally {
    // Alleen onze eigen lock vrijgeven.
    try {
      const cur = await readLockValue();
      if (cur == null || String(cur) === token) await kvDel(RUN_LOCK);
    } catch {
      // lock verloopt vanzelf (TTL)
    }
  }
  return { ranAt, processed };
}

async function readLockValue(): Promise<unknown> {
  const raw = await kvGet<unknown>(RUN_LOCK);
  // Lokaal (.data) staat de waarde in { value, expiresAt }.
  if (raw && typeof raw === "object" && "value" in raw) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}
