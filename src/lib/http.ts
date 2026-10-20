/**
 * fetch met harde time-out + nette, Nederlandse foutmeldingen.
 * Elke fout heeft de vorm `${label}: ${melding}`, zodat de gebruiker ziet
 * welke stap misging. Tokens horen nooit in de melding (we tonen alleen
 * de foutboodschap van de API, nooit de URL).
 */

export interface FetchOpts {
  /** Standaard 15 s. Gebruik 120 s voor video downloaden/uploaden. */
  timeoutMs?: number;
  /** Prefix van de foutmelding, bv. "Facebook-post". */
  label: string;
}

export class HttpError extends Error {
  /** API-foutcode (Meta: getal, TikTok: string) — o.a. voor retries (T7). */
  code?: number | string;
  subcode?: number;
  status?: number;
  timeout?: boolean;
  constructor(
    message: string,
    extra: { code?: number | string; subcode?: number; status?: number; timeout?: boolean } = {},
  ) {
    super(message);
    this.name = "HttpError";
    Object.assign(this, extra);
  }
}

export const API_TIMEOUT_MS = 15_000;
export const MEDIA_TIMEOUT_MS = 120_000;

const TOKEN_EXPIRED = "token verlopen — opnieuw koppelen op Verbindingen";

/** Meta (Graph API) en TikTok foutcodes → Nederlandse uitleg. */
function dutchFor(code: unknown, subcode: unknown): string | null {
  if (subcode === 2207027 || code === 9007) return "media nog niet klaar";
  // TikTok (string-codes)
  if (code === "access_token_invalid") return TOKEN_EXPIRED;
  if (code === "scope_not_authorized") return "permissie ontbreekt";
  if (code === "rate_limit_exceeded" || code === "spam_risk_too_many_posts") {
    return "limiet bereikt, probeer later";
  }
  if (code === 190) return TOKEN_EXPIRED;
  if (code === 10 || (typeof code === "number" && code >= 200 && code <= 299)) {
    return "permissie ontbreekt";
  }
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return "limiet bereikt, probeer later";
  }
  return null;
}

function isTimeout(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
  );
}

function withTimeout(init: RequestInit, timeoutMs: number): RequestInit {
  const t = AbortSignal.timeout(timeoutMs);
  return { ...init, signal: init.signal ? AbortSignal.any([init.signal, t]) : t };
}

function timeoutError(label: string, timeoutMs: number): HttpError {
  return new HttpError(`${label}: time-out na ${Math.round(timeoutMs / 100) / 10}s`, {
    timeout: true,
  });
}

/**
 * Haalt de foutmelding uit een API-antwoord (Meta, Google, TikTok, Instagram).
 * Geeft null als het antwoord geen fout bevat.
 */
function extractError(
  data: unknown,
): { message: string; code?: number | string; subcode?: number; mapped?: boolean } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const err = d.error;
  if (err === undefined || err === null || err === "") return null;

  if (typeof err === "string") {
    const desc =
      typeof d.error_description === "string" ? d.error_description : "";
    return { message: desc ? `${err}: ${desc}` : err };
  }
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    // TikTok stuurt altijd error: {code:'ok'} mee, ook bij succes.
    if (e.code === "ok") return null;
    const base =
      (typeof e.error_user_msg === "string" && e.error_user_msg) ||
      (typeof e.message === "string" && e.message) ||
      "";
    const code = typeof e.code === "number" || typeof e.code === "string" ? e.code : undefined;
    const subcode = typeof e.error_subcode === "number" ? e.error_subcode : undefined;
    if (!base && code === undefined) return null;
    const dutch = dutchFor(code, subcode);
    const codeTxt =
      code !== undefined ? `code ${code}${subcode !== undefined ? `/${subcode}` : ""}` : "";
    const detail = [base, codeTxt].filter(Boolean).join(", ");
    return {
      message: dutch ? `${dutch}${detail ? ` (${detail})` : ""}` : detail,
      code,
      subcode,
      mapped: !!dutch,
    };
  }
  return null;
}

/**
 * fetch + JSON met time-out. Gooit `${label}: ${melding}` bij een HTTP-fout,
 * een `error` in het antwoord of een time-out (`${label}: time-out na Xs`).
 */
export async function fetchJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit = {},
  { timeoutMs = API_TIMEOUT_MS, label }: FetchOpts,
): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, withTimeout(init, timeoutMs));
    text = await res.text();
  } catch (e) {
    if (isTimeout(e)) throw timeoutError(label, timeoutMs);
    throw new HttpError(
      `${label}: netwerkfout (${e instanceof Error ? e.message : "onbekend"})`,
    );
  }

  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  const apiErr = extractError(data);
  if (!res.ok || apiErr) {
    let message = apiErr?.message || "";
    if (res.status === 401 && !apiErr?.mapped) {
      message = message ? `${TOKEN_EXPIRED} (${message})` : TOKEN_EXPIRED;
    }
    if (!message && data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      message =
        (typeof d.error_message === "string" && d.error_message) ||
        (typeof d.message === "string" && d.message) ||
        "";
    }
    throw new HttpError(`${label}: ${message || `HTTP ${res.status}`}`, {
      code: apiErr?.code,
      subcode: apiErr?.subcode,
      status: res.status,
    });
  }
  return (data ?? {}) as T;
}

/**
 * Ruwe fetch met time-out (voor binaire downloads/uploads). Gooit bij een
 * time-out of een HTTP-fout `${label}: ...`. Let op: de time-out loopt door
 * tijdens het lezen van de body.
 */
export async function fetchRaw(
  url: string,
  init: RequestInit = {},
  { timeoutMs = MEDIA_TIMEOUT_MS, label }: FetchOpts,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, withTimeout(init, timeoutMs));
  } catch (e) {
    if (isTimeout(e)) throw timeoutError(label, timeoutMs);
    throw new HttpError(
      `${label}: netwerkfout (${e instanceof Error ? e.message : "onbekend"})`,
    );
  }
  if (!res.ok) {
    throw new HttpError(`${label}: HTTP ${res.status}`, { status: res.status });
  }
  return res;
}

/** Download een bestand als Buffer (met time-out) + het content-type. */
export async function downloadBuffer(
  url: string,
  { timeoutMs = MEDIA_TIMEOUT_MS, label }: FetchOpts,
): Promise<{ buffer: Buffer; contentType: string }> {
  try {
    const res = await fetchRaw(url, {}, { timeoutMs, label });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: videoContentType(res.headers.get("content-type"), url) };
  } catch (e) {
    if (isTimeout(e)) throw timeoutError(label, timeoutMs);
    throw e;
  }
}

/** Content-type van een video: uit de header, anders afgeleid van de extensie. */
export function videoContentType(header: string | null, url: string): string {
  const h = (header || "").split(";")[0].trim().toLowerCase();
  if (h.startsWith("video/")) return h;
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".m4v")) return "video/x-m4v";
  return "video/mp4";
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
