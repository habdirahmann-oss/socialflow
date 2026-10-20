import { HttpError } from "./http";

/**
 * Gedeelde types + helpers voor token-gezondheid (T7).
 * Geen imports van de platform-libs, zodat er geen import-cirkels ontstaan.
 */

export type ConnStatus = "ok" | "needs_reauth";

/** Velden die elke opgeslagen koppeling optioneel heeft. Oude records missen ze. */
export interface TokenHealthFields {
  /** Verloopmoment (ms). 0 of ontbrekend = verloopt niet / onbekend. */
  expiresAt?: number;
  status?: ConnStatus;
  lastError?: string;
  /** Laatste (lees-only) controle of verversing (ms). */
  checkedAt?: number;
}

export type HealthStatus = "ok" | "expiring" | "needs_reauth";

/** Wat GET /api/accounts per kanaal teruggeeft — nooit tokens. */
export interface ChannelHealth {
  status: HealthStatus;
  expiresAt?: number;
  lastError?: string;
  connectedAt?: number;
}

export const DAY_MS = 86_400_000;
/** Minder dan dit nog over → 'expiring' (oranje). */
export const EXPIRING_WITHIN_MS = 10 * DAY_MS;

/** Lock-opties voor read-modify-write mét netwerk-aanroep (token verversen). */
export const REFRESH_LOCK = { ttlSec: 30, waitMs: 25_000 };

export function toHealth(
  input: {
    status?: ConnStatus;
    /** Relevant verloopmoment; 0/undefined = verloopt niet. */
    expiresAt?: number;
    lastError?: string;
    connectedAt?: number;
  },
  now = Date.now(),
): ChannelHealth {
  const expiresAt = input.expiresAt && input.expiresAt > 0 ? input.expiresAt : undefined;
  const connectedAt = input.connectedAt || undefined;
  const expired = expiresAt !== undefined && expiresAt <= now;
  if (input.status === "needs_reauth" || expired) {
    return {
      status: "needs_reauth",
      expiresAt,
      lastError: input.lastError || (expired ? "Token is verlopen" : undefined),
      connectedAt,
    };
  }
  if (expiresAt !== undefined && expiresAt - now < EXPIRING_WITHIN_MS) {
    return { status: "expiring", expiresAt, connectedAt };
  }
  return { status: "ok", expiresAt, connectedAt };
}

/** De Nederlandse melding als een koppeling opnieuw verbonden moet worden. */
export function expiredMessage(platform: string): string {
  return `${platform}-koppeling verlopen — opnieuw verbinden op Verbindingen`;
}

/** Foutmelding als korte tekst (zonder URL's; http.ts zet nooit tokens in meldingen). */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "onbekende fout");
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

/**
 * Tijdelijke fout (time-out, netwerk, 5xx, 429): zegt niets over de geldigheid
 * van het token → niet op 'opnieuw verbinden nodig' zetten.
 */
export function isTransientError(e: unknown): boolean {
  if (e instanceof HttpError) {
    if (e.timeout) return true;
    if (e.status === undefined) return true; // netwerkfout
    return e.status === 429 || e.status >= 500;
  }
  return false;
}

/** Meta/Instagram Graph-fout 190 = token ongeldig/verlopen. */
export function isMetaTokenError(e: unknown): boolean {
  return e instanceof HttpError && e.code === 190;
}

/** Dagen tot `ts` (afgerond naar boven, min. 0). */
export function daysUntil(ts: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((ts - now) / DAY_MS));
}
