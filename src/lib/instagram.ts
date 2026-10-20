import { kvGet, kvSet, kvUpdate, withLock } from "./store";
import { publishIgMedia, type IgPlacement } from "./ig-media";
import { fetchJson } from "./http";
import {
  DAY_MS,
  REFRESH_LOCK,
  errorText,
  isMetaTokenError,
  isTransientError,
  toHealth,
  type ChannelHealth,
  type TokenHealthFields,
} from "./token-status";

/* ---------------- Config ---------------- */

export const IG = {
  appId: process.env.INSTAGRAM_APP_ID || "",
  appSecret: process.env.INSTAGRAM_APP_SECRET || "",
  appUrl: process.env.APP_URL || "http://localhost:3000",
};

export const IG_REDIRECT_URI = `${IG.appUrl}/api/auth/instagram/callback`;

export const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
].join(",");

export function igConfigured(): boolean {
  return Boolean(IG.appId && IG.appSecret);
}

/* ---------------- OAuth (Instagram Login) ---------------- */

export function igLoginUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: IG.appId,
    redirect_uri: IG_REDIRECT_URI,
    response_type: "code",
    scope: IG_SCOPES,
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

interface ShortToken {
  access_token: string;
  user_id: number | string;
}

export async function igExchangeCode(code: string): Promise<ShortToken> {
  const body = new URLSearchParams({
    client_id: IG.appId,
    client_secret: IG.appSecret,
    grant_type: "authorization_code",
    redirect_uri: IG_REDIRECT_URI,
    code: code.replace(/#_$/, ""),
  });
  const data = await fetchJson<{ access_token?: string; user_id?: number | string }>(
    "https://api.instagram.com/oauth/access_token",
    { method: "POST", body },
    { label: "IG token-uitwisseling" },
  );
  if (!data.access_token) throw new Error("IG token-uitwisseling mislukt");
  return { access_token: data.access_token, user_id: data.user_id ?? "" };
}

/** Wissel kortlevend token in voor langlevend (~60 dagen). */
export async function igLongLivedToken(
  shortToken: string,
): Promise<{ token: string; expiresAt: number }> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: IG.appSecret,
    access_token: shortToken,
  });
  const data = await fetchJson<{ access_token?: string; expires_in?: number }>(
    `https://graph.instagram.com/access_token?${params}`,
    {},
    { label: "IG long-lived token" },
  );
  if (!data.access_token) throw new Error("IG long-lived token mislukt");
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || IG_TOKEN_LIFETIME_S) * 1000,
  };
}

/** Langlevende IG-tokens gelden 60 dagen. */
const IG_TOKEN_LIFETIME_S = 60 * 86_400;

/**
 * Ververs een langlevend IG-token (moet ≥ 24 uur oud en nog geldig zijn).
 * Geeft een nieuw token met weer ~60 dagen looptijd.
 */
export async function igRefreshToken(
  token: string,
): Promise<{ token: string; expiresAt: number }> {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: token,
  });
  const data = await fetchJson<{ access_token?: string; expires_in?: number }>(
    `https://graph.instagram.com/refresh_access_token?${params}`,
    {},
    { label: "IG token-verversing" },
  );
  if (!data.access_token) throw new Error("IG token-verversing mislukt");
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || IG_TOKEN_LIFETIME_S) * 1000,
  };
}

export async function igProfile(
  token: string,
): Promise<{ id: string; username: string }> {
  const params = new URLSearchParams({ fields: "user_id,username", access_token: token });
  const data = await fetchJson<{ user_id?: string | number; username?: string }>(
    `https://graph.instagram.com/me?${params}`,
    {},
    { label: "IG profiel ophalen" },
  );
  return { id: String(data.user_id ?? ""), username: data.username ?? "" };
}

/** Lees-only controle (testmodus): werkt het Instagram-token nog? */
export async function checkInstagramDirect(token: string, timeoutMs = 5000): Promise<void> {
  const params = new URLSearchParams({ fields: "username", access_token: token });
  await fetchJson(`https://graph.instagram.com/me?${params}`, {}, {
    label: "Instagram-koppeling",
    timeoutMs,
  });
}

/* ---------------- Opslag per account ---------------- */

export interface IgConnection extends TokenHealthFields {
  token: string;
  igUserId: string;
  username: string;
  obtainedAt: number;
  /** Laatste verversing(spoging) van het token (ms); max. 1× per 24 uur. */
  refreshedAt?: number;
}

type IgStoreMap = Record<string, IgConnection>;
const IG_KEY = "ig-tokens";

/** Oude records zonder expiresAt: koppelmoment + 60 dagen. */
function withDefaults(conn: IgConnection): IgConnection {
  return conn.expiresAt
    ? conn
    : { ...conn, expiresAt: conn.obtainedAt + IG_TOKEN_LIFETIME_S * 1000 };
}

/** Effectieve status: opgeslagen status of verlopen token. */
export function igNeedsReauth(conn: IgConnection, now = Date.now()): boolean {
  const c = withDefaults(conn);
  return c.status === "needs_reauth" || (c.expiresAt ?? 0) <= now;
}

export async function saveIgConnection(
  accountId: string,
  conn: IgConnection,
): Promise<void> {
  await kvUpdate<IgStoreMap>(IG_KEY, (cur) => ({ ...(cur ?? {}), [accountId]: conn }));
}

/** Zet de Instagram-login van dit account op 'opnieuw verbinden nodig'. */
export async function markIgNeedsReauth(
  accountId: string,
  lastError: string,
): Promise<void> {
  await kvUpdate<IgStoreMap>(IG_KEY, (cur) => {
    const map = cur ?? {};
    const c = map[accountId];
    if (c) {
      map[accountId] = {
        ...c,
        status: "needs_reauth",
        lastError,
        checkedAt: Date.now(),
      };
    }
    return map;
  });
}

/** Moet dit token nu ververst worden? (>24 u sinds koppelen/verversen, nog geldig) */
function refreshDue(c: IgConnection, now: number): boolean {
  if (c.status === "needs_reauth") return false;
  if ((c.expiresAt ?? 0) <= now) return false;
  return now - (c.refreshedAt ?? c.obtainedAt) > DAY_MS;
}

/**
 * Laadt de IG-koppeling. Ververst het token (onder `lock:ig-tokens`) als het
 * ouder is dan 24 uur en nog niet verlopen — hooguit 1× per 24 uur.
 * Bij een definitieve fout → status needs_reauth + lastError.
 */
export async function loadIgConnection(
  accountId: string,
): Promise<IgConnection | null> {
  const map = (await kvGet<IgStoreMap>(IG_KEY)) ?? {};
  const raw = map[accountId];
  if (!raw) return null;
  const conn = withDefaults(raw);
  if (!refreshDue(conn, Date.now())) return conn;
  try {
    return await withLock(
      `lock:${IG_KEY}`,
      async () => {
        const fresh = (await kvGet<IgStoreMap>(IG_KEY)) ?? {};
        const curRaw = fresh[accountId];
        if (!curRaw) return null;
        const cur = withDefaults(curRaw);
        const now = Date.now();
        // intussen al ververst door een parallelle aanvraag?
        if (!refreshDue(cur, now)) return cur;
        let updated: IgConnection;
        try {
          const t = await igRefreshToken(cur.token);
          updated = {
            ...cur,
            token: t.token,
            expiresAt: t.expiresAt,
            refreshedAt: now,
            checkedAt: now,
            status: "ok",
          };
          delete updated.lastError;
        } catch (e) {
          updated = isTransientError(e)
            ? // tijdelijk probleem: token is nog geldig, morgen opnieuw proberen
              { ...cur, refreshedAt: now, checkedAt: now, lastError: errorText(e) }
            : {
                ...cur,
                refreshedAt: now,
                checkedAt: now,
                status: "needs_reauth",
                lastError: errorText(e),
              };
        }
        fresh[accountId] = updated;
        await kvSet(IG_KEY, fresh);
        return updated;
      },
      REFRESH_LOCK,
    );
  } catch {
    return conn; // opslag bezet: gebruik wat we hebben
  }
}

/**
 * Lees-only controle voor de dagelijkse health-run: werkt het token nog?
 * Fout 190 → needs_reauth.
 */
export async function checkIgTokenHealth(accountId: string): Promise<void> {
  const conn = await loadIgConnection(accountId); // ververst indien nodig
  if (!conn || igNeedsReauth(conn)) return;
  try {
    await checkInstagramDirect(conn.token);
  } catch (e) {
    if (isMetaTokenError(e)) await markIgNeedsReauth(accountId, errorText(e));
  }
}

/** Gezondheid van de IG-login. Nooit tokens. */
export function igHealth(conn: IgConnection, now = Date.now()): ChannelHealth {
  const c = withDefaults(conn);
  const expired = (c.expiresAt ?? 0) <= now;
  return toHealth(
    {
      status: c.status,
      expiresAt: c.expiresAt,
      lastError: c.lastError || (expired ? "Instagram-token verlopen (60 dagen)" : undefined),
      connectedAt: c.obtainedAt,
    },
    now,
  );
}

export async function clearIgConnection(accountId: string): Promise<void> {
  await kvUpdate<IgStoreMap>(IG_KEY, (cur) => {
    const map = cur ?? {};
    delete map[accountId];
    return map;
  });
}

/* ---------------- Posten (graph.instagram.com) ---------------- */

export async function postToInstagramDirect(
  conn: IgConnection,
  media: { url: string; kind: "image" | "video" },
  caption: string,
  placement: IgPlacement,
): Promise<{ id: string; permalink?: string }> {
  return publishIgMedia({
    base: "https://graph.instagram.com",
    igId: conn.igUserId,
    token: conn.token,
    media,
    caption,
    placement,
  });
}
