/**
 * Eenvoudige toegangspoort: één wachtwoord (APP_PASSWORD), één cookie per apparaat.
 *
 * Gebruikt alleen Web Crypto (`crypto.subtle`), zodat dezelfde code werkt in
 * de proxy (src/proxy.ts) én in route handlers.
 *
 * - Zonder APP_PASSWORD staat de poort uit (lokaal ontwikkelen blijft vrij).
 * - De cookie bevat nooit het wachtwoord zelf, maar een HMAC ervan. Wijzig je
 *   het wachtwoord, dan zijn alle bestaande sessies direct ongeldig.
 */

export const SESSION_COOKIE = "sf_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // 1 jaar

const SESSION_MESSAGE = "socialflow-session-v1";
const encoder = new TextEncoder();

export function authEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time vergelijking van twee strings van gelijke lengte. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Sessietoken = hex HMAC-SHA256(key=APP_PASSWORD, msg='socialflow-session-v1'). */
export async function sessionToken(): Promise<string> {
  return hmacHex(process.env.APP_PASSWORD || "", SESSION_MESSAGE);
}

/**
 * Vergelijkt een ingevoerd wachtwoord constant-time met APP_PASSWORD.
 * Beide kanten worden eerst gehasht, zodat de lengte niets lekt.
 */
export async function checkPassword(input: string): Promise<boolean> {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  const [a, b] = await Promise.all([
    hmacHex(SESSION_MESSAGE, input),
    hmacHex(SESSION_MESSAGE, expected),
  ]);
  return timingSafeEqualStr(a, b);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** true als de request een geldige sessiecookie heeft (of de poort uit staat). */
export async function isAuthed(req: Request): Promise<boolean> {
  if (!authEnabled()) return true;
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return false;
  return timingSafeEqualStr(cookie, await sessionToken());
}

/** Geeft een 401-response terug als de request niet ingelogd is, anders null. */
export async function requireAuth(req: Request): Promise<Response | null> {
  if (await isAuthed(req)) return null;
  return Response.json({ error: "Niet ingelogd" }, { status: 401 });
}

/** Alleen interne paden ('/...', niet '//' of '/\'), anders '/'. */
export function sanitizeNext(next: unknown): string {
  if (typeof next !== "string") return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}
