import { NextResponse } from "next/server";
import { timingSafeEqual, randomUUID } from "crypto";
import { duePosts, processPost } from "@/lib/schedule";
import { kvSetNX, kvGet, kvDel, kvSet } from "@/lib/store";
import { runDailyTokenHealth } from "@/lib/token-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby + Fluid Compute staat 300 s toe (projectinstelling: default 300 s).
export const maxDuration = 300;

const RUN_LOCK = "lock:cron";
/** Langer dan maxDuration, zodat er nooit twee runs tegelijk lopen. */
const RUN_LOCK_TTL_SEC = 310;
/** Max aantal posts per run (video's kunnen lang duren). */
const MAX_POSTS_PER_RUN = 3;
/**
 * Na deze tijd pakken we geen nieuwe post meer op: een video-post kan ~250 s
 * duren. De rest volgt bij de volgende run (elke 5 min).
 */
const PICK_WINDOW_MS = 45_000;
/** Uiterste tijdstip voor plaatsingen (maxDuration 300 s, rest = opslaan). */
const PUBLISH_DEADLINE_MS = 270_000;
/** Alleen nog de dagelijkse token-run starten als er zoveel tijd over is. */
const HEALTH_WINDOW_MS = 240_000;

/**
 * Verstuurt ingeplande posts waarvan de tijd verstreken is.
 * Aangeroepen door GitHub Actions (elke 5 min) en Vercel Cron (dagelijkse backup).
 * Beschermd met CRON_SECRET via de header `Authorization: Bearer <CRON_SECRET>`.
 */
async function run(req: Request) {
  // Fail closed: zonder CRON_SECRET draait er niets.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET ontbreekt" }, { status: 503 });
  }
  // Alleen de header 'Authorization: Bearer <secret>' (ook wat Vercel Cron stuurt).
  const header = req.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ranAt = Date.now();
  const token = `${ranAt}-${randomUUID()}`;
  if (!(await kvSetNX(RUN_LOCK, token, RUN_LOCK_TTL_SEC))) {
    return NextResponse.json({ ranAt, skipped: "busy" });
  }

  const processed: {
    id: string;
    status?: string;
    attempts?: number;
    error?: string;
  }[] = [];
  try {
    const tried = new Set<string>();
    while (
      processed.length < MAX_POSTS_PER_RUN &&
      Date.now() - ranAt < PICK_WINDOW_MS
    ) {
      const now = Date.now();
      const next = (await duePosts(now)).find((p) => !tried.has(p.id));
      if (!next) break;
      tried.add(next.id);
      try {
        const done = await processPost(next.id, now, {
          deadline: ranAt + PUBLISH_DEADLINE_MS,
        });
        if (done) {
          processed.push({
            id: done.id,
            status: done.status,
            attempts: done.attempts,
          });
        }
      } catch (e) {
        processed.push({
          id: next.id,
          error: e instanceof Error ? e.message : "cron-fout",
        });
      }
    }
    // Dagelijks (max. 1× per 24 u, key 'token-health-last'): IG-tokens verversen
    // en lees-only token-controles voor alle accounts. Posts gaan voor.
    let tokenHealth: { ranAt: number; accounts: number } | null = null;
    if (Date.now() - ranAt < HEALTH_WINDOW_MS) {
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

  return NextResponse.json({ ranAt, processed });
}

async function readLockValue(): Promise<unknown> {
  const raw = await kvGet<unknown>(RUN_LOCK);
  // Lokaal (.data) staat de waarde in { value, expiresAt }.
  if (raw && typeof raw === "object" && "value" in raw) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

export const GET = run;
export const POST = run;
