/**
 * Upstash QStash: laat de cron-route precies op het geplande tijdstip draaien
 * (i.p.v. te wachten op de 5-minuten-backup). Alleen actief met QSTASH_TOKEN
 * (komt vanzelf mee met de Upstash QStash-integratie in Vercel).
 */
import { APP_URL } from "./config";

export function qstashConfigured(): boolean {
  return Boolean(process.env.QSTASH_TOKEN && process.env.CRON_SECRET);
}

/** Plant één aanroep van /api/cron/publish op `at` (ms). Best effort: fouten worden gelogd. */
export async function enqueueCronAt(at: number): Promise<void> {
  if (!qstashConfigured()) return;
  const base = (process.env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/+$/, "");
  const target = `${APP_URL}/api/cron/publish`;
  try {
    const res = await fetch(`${base}/v2/publish/${target}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
        // QStash stuurt deze header door naar onze route (als 'Authorization').
        "upstash-forward-authorization": `Bearer ${process.env.CRON_SECRET}`,
        "upstash-not-before": String(Math.max(Math.ceil(at / 1000), Math.ceil(Date.now() / 1000))),
        "upstash-retries": "2",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[qstash] inplannen mislukt: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[qstash] inplannen mislukt: ${e instanceof Error ? e.message : e}`);
  }
}
