import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { accountExists } from "./accounts";
import { APP_URL } from "./config";

/**
 * Ondertekende OAuth-state (CSRF-bescherming voor de koppel-flows).
 *
 * state = base64url(JSON{a: accountId, p: provider, t: tijdstip ms, n: nonce})
 *         + "." + base64url(HMAC-SHA256(geheim, payload))
 *
 * De nonce staat óók in een httpOnly-cookie `sf_oauth_<provider>` die de
 * login-route zet. De callback accepteert alleen een state met een geldige
 * handtekening, het juiste platform, jonger dan 10 minuten, een nonce gelijk
 * aan de cookie én een bestaand account.
 *
 * Geheim: OAUTH_STATE_SECRET, anders APP_PASSWORD, META_APP_SECRET of
 * CRON_SECRET (zodat het met de huidige env-variabelen al werkt).
 */

export type OAuthProvider = "meta" | "instagram" | "tiktok" | "youtube";

/** Querystring-sleutel waarmee /verbindingen het resultaat per platform leest. */
export const RESULT_PARAM: Record<OAuthProvider, string> = {
  meta: "meta",
  instagram: "ig",
  tiktok: "tt",
  youtube: "yt",
};

export const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;
/** Toegestane klokafwijking naar de toekomst. */
const CLOCK_SKEW_MS = 60_000;
const COOKIE_PATH = "/api/auth";
const HMAC_CONTEXT = "socialflow-oauth-state-v1";

/** Vaste melding voor de gebruiker bij een afgekeurde state. */
export const INVALID_STATE_REASON = "Ongeldige of verlopen koppelpoging";

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

export function oauthCookieName(provider: OAuthProvider): string {
  return `sf_oauth_${provider}`;
}

function stateSecret(): string {
  const s =
    process.env.OAUTH_STATE_SECRET ||
    process.env.APP_PASSWORD ||
    process.env.META_APP_SECRET ||
    process.env.CRON_SECRET;
  if (!s) throw new OAuthStateError("Geen geheim ingesteld om de koppelpoging te ondertekenen");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", stateSecret())
    .update(`${HMAC_CONTEXT}.${payload}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Maakt een ondertekende state + de nonce die in de cookie moet. */
export function makeState(
  accountId: string,
  provider: OAuthProvider,
  now: number = Date.now(),
): { state: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ a: accountId, p: provider, t: now, n: nonce }),
  ).toString("base64url");
  return { state: `${payload}.${sign(payload)}`, nonce };
}

/**
 * Controleert de state. Geeft het account-id terug, of gooit een
 * OAuthStateError met een Nederlandse reden.
 */
export async function verifyState(
  state: string | null | undefined,
  provider: OAuthProvider,
  cookieNonce: string | null | undefined,
  now: number = Date.now(),
): Promise<string> {
  if (!state) throw new OAuthStateError("Koppelpoging zonder state");
  const dot = state.lastIndexOf(".");
  if (dot <= 0 || dot === state.length - 1) {
    throw new OAuthStateError("State is niet ondertekend");
  }
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) {
    throw new OAuthStateError("Handtekening van de state klopt niet");
  }

  let data: { a?: unknown; p?: unknown; t?: unknown; n?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new OAuthStateError("State is onleesbaar");
  }
  if (
    !data ||
    typeof data.a !== "string" ||
    typeof data.p !== "string" ||
    typeof data.t !== "number" ||
    typeof data.n !== "string"
  ) {
    throw new OAuthStateError("State is onvolledig");
  }
  if (data.p !== provider) {
    throw new OAuthStateError("Koppelpoging hoort bij een ander platform");
  }
  const age = now - data.t;
  if (age > OAUTH_STATE_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    throw new OAuthStateError("Koppelpoging is verlopen (ouder dan 10 minuten)");
  }
  if (!cookieNonce || !safeEqual(cookieNonce, data.n)) {
    throw new OAuthStateError("Koppelpoging is niet in deze browser gestart");
  }
  if (!(await accountExists(data.a))) {
    throw new OAuthStateError("Account bestaat niet (meer)");
  }
  return data.a;
}

/* ---------------- Cookie-helpers voor de routes ---------------- */

/** Zet de nonce-cookie op de redirect-response van de login-route. */
export function setStateCookie(
  res: NextResponse,
  provider: OAuthProvider,
  nonce: string,
): void {
  res.cookies.set({
    name: oauthCookieName(provider),
    value: nonce,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // de terugkeer van Meta/Google/TikTok is een top-level GET
    path: COOKIE_PATH,
    maxAge: OAUTH_STATE_MAX_AGE_MS / 1000,
  });
}

/** Verwijdert de nonce-cookie (eenmalig gebruik). */
export function clearStateCookie(res: NextResponse, provider: OAuthProvider): void {
  res.cookies.set({
    name: oauthCookieName(provider),
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: COOKIE_PATH,
    maxAge: 0,
  });
}

export function readStateCookie(req: NextRequest, provider: OAuthProvider): string | null {
  return req.cookies.get(oauthCookieName(provider))?.value || null;
}

/**
 * Terug naar /verbindingen met `<param>=<status>` (+ reden). Het account-id
 * gaat alleen mee als de state geldig was.
 */
export function verbindingenUrl(
  provider: OAuthProvider,
  status: string,
  opts: { accountId?: string | null; reden?: string } = {},
): string {
  const qs = new URLSearchParams();
  if (opts.accountId) qs.set("account", opts.accountId);
  qs.set(RESULT_PARAM[provider], status);
  if (opts.reden) qs.set("reden", opts.reden);
  return `${APP_URL}/verbindingen?${qs}`;
}

/**
 * Gemeenschappelijk begin van elke callback: state controleren tegen de cookie.
 * Geeft het account-id terug, of null (de reden wordt gelogd, zonder state/code).
 */
export async function accountFromCallback(
  req: NextRequest,
  provider: OAuthProvider,
): Promise<string | null> {
  const state = new URL(req.url).searchParams.get("state");
  try {
    return await verifyState(state, provider, readStateCookie(req, provider));
  } catch (e) {
    const reason = e instanceof Error ? e.message : "onbekend";
    console.warn(`[oauth:${provider}] koppelpoging afgewezen: ${reason}`);
    return null;
  }
}

/**
 * Redirect-response terug naar /verbindingen die altijd de nonce-cookie wist.
 */
export function backToVerbindingen(
  provider: OAuthProvider,
  status: string,
  opts: { accountId?: string | null; reden?: string } = {},
): NextResponse {
  const res = NextResponse.redirect(verbindingenUrl(provider, status, opts));
  clearStateCookie(res, provider);
  return res;
}
