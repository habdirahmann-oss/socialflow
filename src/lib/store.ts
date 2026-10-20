import { promises as fs } from "fs";
import path from "path";
import { Redis } from "@upstash/redis";

/**
 * Eenvoudige JSON key-value opslag.
 * - Op Vercel (KV_REST_API_* aanwezig): Upstash Redis.
 * - Lokaal: JSON-bestanden in .data/.
 */

// Vercel/Upstash zetten verschillende env-namen afhankelijk van de integratie.
const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
    : null;

const DATA_DIR = path.join(process.cwd(), ".data");

export async function kvGet<T>(key: string): Promise<T | null> {
  if (redis) {
    return (await redis.get<T>(key)) ?? null;
  }
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, `${key}.json`), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  if (redis) {
    await redis.set(key, value);
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, `${key}.json`),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

interface LocalLockFile {
  value: unknown;
  expiresAt: number;
}

/**
 * Zet `key` alleen als die nog niet bestaat (of verlopen is), met een TTL.
 * Geeft true terug als het gelukt is. Redis: atomisch via SET NX EX.
 * Lokaal (.data): bestand met {value, expiresAt}; binnen één proces geserialiseerd,
 * tussen processen niet volledig atomisch — prima voor ontwikkeling.
 */
export async function kvSetNX<T>(
  key: string,
  value: T,
  ttlSec: number,
): Promise<boolean> {
  if (redis) {
    const res = await redis.set(key, value, { nx: true, ex: ttlSec });
    return res === "OK";
  }
  return serialLocal(async () => {
    const file = path.join(DATA_DIR, `${key}.json`);
    const data: LocalLockFile = { value, expiresAt: Date.now() + ttlSec * 1000 };
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      // 'wx' faalt als het bestand al bestaat (ook tussen processen).
      await fs.writeFile(file, JSON.stringify(data), { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      // bestaat al → alleen overnemen als hij verlopen/onleesbaar is
    }
    try {
      const cur = JSON.parse(await fs.readFile(file, "utf8")) as LocalLockFile;
      if (cur && typeof cur.expiresAt === "number" && cur.expiresAt > Date.now()) {
        return false;
      }
    } catch {
      // onleesbaar: mogelijk wordt hij nét geschreven → alleen overnemen als hij oud is
      try {
        const st = await fs.stat(file);
        if (Date.now() - st.mtimeMs < 60_000) return false;
      } catch {
        // intussen verdwenen → overnemen
      }
    }
    await fs.writeFile(file, JSON.stringify(data), "utf8");
    return true;
  });
}

/**
 * Lokaal: alle lock-pogingen binnen dit proces na elkaar uitvoeren, zodat
 * check-en-zet niet door elkaar loopt. Via globalThis omdat elke route-bundle
 * z'n eigen kopie van deze module kan hebben.
 */
const g = globalThis as { __socialflowLocalNX?: Promise<unknown> };
function serialLocal<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__socialflowLocalNX ?? Promise.resolve();
  const next = prev.then(fn, fn);
  g.__socialflowLocalNX = next.catch(() => {});
  return next;
}

export async function kvDel(key: string): Promise<void> {
  if (redis) {
    await redis.del(key);
    return;
  }
  try {
    await fs.unlink(path.join(DATA_DIR, `${key}.json`));
  } catch {
    // al weg
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Voert `fn` uit onder een korte distributed lock (read-modify-write op één key).
 * Wacht maximaal `waitMs`; geeft daarna een nette fout.
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ttlSec?: number; waitMs?: number } = {},
): Promise<T> {
  const ttlSec = opts.ttlSec ?? 15;
  const waitMs = opts.waitMs ?? 8000;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  while (!(await kvSetNX(name, token, ttlSec))) {
    if (Date.now() >= deadline) {
      throw new Error("Opslag is bezet, probeer het zo opnieuw");
    }
    await sleep(100 + Math.floor(Math.random() * 150));
  }
  try {
    return await fn();
  } finally {
    // Alleen vrijgeven als de lock nog van ons is (niet verlopen en door een ander gepakt).
    try {
      const cur = redis
        ? await kvGet<string>(name)
        : ((await kvGet<LocalLockFile>(name))?.value as string | undefined);
      if (cur == null || String(cur) === token) await kvDel(name);
    } catch {
      await kvDel(name).catch(() => {});
    }
  }
}

/**
 * Read-modify-write van één key onder `withLock("lock:<key>")`, zodat parallelle
 * schrijvers (bv. token-verversingen vanuit GET /api/accounts) elkaars
 * wijzigingen niet overschrijven. Let op: niet nesten op dezelfde key.
 */
export async function kvUpdate<T>(
  key: string,
  fn: (cur: T | null) => T | Promise<T>,
  opts: { ttlSec?: number; waitMs?: number } = {},
): Promise<T> {
  return withLock(
    `lock:${key}`,
    async () => {
      const next = await fn(await kvGet<T>(key));
      await kvSet(key, next);
      return next;
    },
    opts,
  );
}
