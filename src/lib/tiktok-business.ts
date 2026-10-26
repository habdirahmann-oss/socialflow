/**
 * TikTok API for Business (Organic API / Accounts API): direct openbaar posten
 * naar TikTok-accounts die je beheert (merken, bureaus). Aparte developer-app
 * op business-api.tiktok.com met de permissie "TikTok Accounts".
 *
 * Env: TTB_APP_ID, TTB_APP_SECRET en TTB_AUTH_URL (de "TikTok account holder
 * authorization URL" uit My Apps > App Detail > Basic Information).
 */
import { kvGet, kvSet, kvUpdate, withLock } from "./store";
import { APP_URL } from "./config";
import { fetchJson, sleep } from "./http";
import {
  REFRESH_LOCK,
  errorText,
  isTransientError,
  toHealth,
  type ChannelHealth,
  type TokenHealthFields,
} from "./token-status";
import { parseTikTokSettings } from "./tiktok-settings";

const API = "https://business-api.tiktok.com/open_api/v1.3";

export const TTB = {
  appId: process.env.TTB_APP_ID || "",
  appSecret: process.env.TTB_APP_SECRET || "",
  authUrl: process.env.TTB_AUTH_URL || "",
};

/** Moet exact overeenkomen met de redirect-URL in de app (met slash op het eind). */
export const TTB_REDIRECT_URI = `${APP_URL}/api/auth/ttbiz/callback/`;

export function ttbConfigured(): boolean {
  return Boolean(TTB.appId && TTB.appSecret && TTB.authUrl);
}

/** Autorisatie-URL uit het portal + onze state; altijd het toestemmingsscherm tonen. */
export function ttbLoginUrl(state: string): string {
  const url = new URL(TTB.authUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("disable_auto_auth", "1");
  return url.toString();
}

/** Business API: HTTP 200 met `code` ≠ 0 is ook een fout. */
async function call<T>(
  path: string,
  body: unknown,
  label: string,
  accessToken?: string,
): Promise<T> {
  const res = await fetchJson<{ code?: number; message?: string; data?: T }>(
    `${API}${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { "access-token": accessToken } : {}),
      },
      body: JSON.stringify(body),
    },
    { label },
  );
  if (res.code !== 0) throw new Error(`${label}: ${res.message || `code ${res.code}`}`);
  return res.data as T;
}

interface TtbTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  open_id: string;
  scope?: string;
}

export function ttbExchangeCode(code: string): Promise<TtbTokens> {
  return call<TtbTokens>(
    "/tt_user/oauth2/token/",
    {
      client_id: TTB.appId,
      client_secret: TTB.appSecret,
      grant_type: "authorization_code",
      auth_code: code,
      redirect_uri: TTB_REDIRECT_URI,
    },
    "TikTok Business token-uitwisseling",
  );
}

function ttbRefresh(refreshToken: string): Promise<TtbTokens> {
  return call<TtbTokens>(
    "/tt_user/oauth2/refresh_token/",
    {
      client_id: TTB.appId,
      client_secret: TTB.appSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    "TikTok Business token-verversing",
  );
}

/** Naam van het gekoppelde account (best effort). */
export async function ttbDisplayName(accessToken: string, openId: string): Promise<string> {
  try {
    const qs = new URLSearchParams({
      business_id: openId,
      fields: JSON.stringify(["display_name", "username"]),
    });
    const res = await fetchJson<{
      code?: number;
      data?: { display_name?: string; username?: string };
    }>(`${API}/business/get/?${qs}`, { headers: { "access-token": accessToken } }, {
      label: "TikTok Business-profiel",
      timeoutMs: 8000,
    });
    return res.data?.display_name || res.data?.username || "TikTok-account";
  } catch {
    return "TikTok-account";
  }
}

/* ---------------- Opslag per account ---------------- */

export interface TtbConnection extends TokenHealthFields {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  /** open_id = business_id in de publish-endpoints. */
  openId: string;
  displayName: string;
  obtainedAt: number;
}

type TtbStoreMap = Record<string, TtbConnection>;
const KEY = "tiktok-business-tokens";

export async function saveTtbConnection(accountId: string, conn: TtbConnection): Promise<void> {
  await kvUpdate<TtbStoreMap>(KEY, (cur) => ({ ...(cur ?? {}), [accountId]: conn }));
}

export async function clearTtbConnection(accountId: string): Promise<void> {
  await kvUpdate<TtbStoreMap>(KEY, (cur) => {
    const map = cur ?? {};
    delete map[accountId];
    return map;
  });
}

const refreshDue = (c: TtbConnection, now: number) =>
  c.status !== "needs_reauth" && now > c.expiresAt - 5 * 60_000;

/** Laadt de koppeling en ververst het (1-daagse) access-token onder een lock. */
export async function loadTtbConnection(accountId: string): Promise<TtbConnection | null> {
  const conn = ((await kvGet<TtbStoreMap>(KEY)) ?? {})[accountId] || null;
  if (!conn || !refreshDue(conn, Date.now())) return conn;
  try {
    return await withLock(
      `lock:${KEY}`,
      async () => {
        const fresh = (await kvGet<TtbStoreMap>(KEY)) ?? {};
        const cur = fresh[accountId];
        if (!cur) return null;
        const now = Date.now();
        if (!refreshDue(cur, now)) return cur;
        let updated: TtbConnection;
        try {
          const t = await ttbRefresh(cur.refreshToken);
          updated = {
            ...cur,
            accessToken: t.access_token,
            refreshToken: t.refresh_token || cur.refreshToken,
            expiresAt: now + (t.expires_in || 86400) * 1000,
            refreshExpiresAt: t.refresh_token_expires_in
              ? now + t.refresh_token_expires_in * 1000
              : cur.refreshExpiresAt,
            checkedAt: now,
            status: "ok",
          };
          delete updated.lastError;
        } catch (e) {
          updated = isTransientError(e)
            ? { ...cur, checkedAt: now, lastError: errorText(e) }
            : { ...cur, checkedAt: now, status: "needs_reauth", lastError: errorText(e) };
        }
        fresh[accountId] = updated;
        await kvSet(KEY, fresh);
        return updated;
      },
      REFRESH_LOCK,
    );
  } catch {
    return conn;
  }
}

export function ttbHealth(conn: TtbConnection, now = Date.now()): ChannelHealth {
  return toHealth(
    {
      status: conn.status,
      expiresAt: conn.refreshExpiresAt,
      lastError: conn.lastError,
      connectedAt: conn.obtainedAt,
    },
    now,
  );
}

/* ---------------- Posten ---------------- */

/** Volgt de publicatie tot TikTok klaar is of een fout meldt (max ~60 s). */
async function waitForPublish(conn: TtbConnection, publishId: string): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await sleep(4000);
    const qs = new URLSearchParams({ business_id: conn.openId, publish_id: publishId });
    const st = await fetchJson<{
      code?: number;
      data?: { status?: string; reason?: string };
    }>(`${API}/business/publish/status/?${qs}`, { headers: { "access-token": conn.accessToken } }, {
      label: "TikTok-publicatiestatus",
      timeoutMs: 10_000,
    }).catch(() => null);
    const status = st?.data?.status;
    if (status === "PUBLISH_COMPLETE") return;
    if (status === "FAILED") {
      throw new Error(`TikTok-publicatie mislukt: ${st?.data?.reason || "onbekende reden"}`);
    }
  }
}

/** Keuzes van de maker → post_info (reacties/duet/stitch, reclame-melding). */
function postInfo(caption: string, settings: unknown, kind: "video" | "photo") {
  const s = parseTikTokSettings(settings);
  return {
    caption: caption.slice(0, kind === "video" ? 2200 : 4000),
    disable_comment: s ? !s.allowComment : false,
    ...(kind === "video"
      ? { disable_duet: s ? !s.allowDuet : false, disable_stitch: s ? !s.allowStitch : false }
      : {}),
    is_brand_organic: Boolean(s?.yourBrand),
    is_branded_content: Boolean(s?.brandedContent),
  };
}

export async function ttbPublishVideo(
  conn: TtbConnection,
  videoUrl: string,
  caption: string,
  settings?: unknown,
): Promise<{ id: string }> {
  const data = await call<{ share_id?: string }>(
    "/business/video/publish/",
    { business_id: conn.openId, video_url: videoUrl, post_info: postInfo(caption, settings, "video") },
    "TikTok-video publiceren",
    conn.accessToken,
  );
  if (!data?.share_id) throw new Error("TikTok-video publiceren: geen id ontvangen");
  await waitForPublish(conn, data.share_id);
  return { id: data.share_id };
}

export async function ttbPublishPhotos(
  conn: TtbConnection,
  imageUrls: string[],
  caption: string,
  title?: string,
  settings?: unknown,
): Promise<{ id: string }> {
  const s = parseTikTokSettings(settings);
  const data = await call<{ share_id?: string }>(
    "/business/photo/publish/",
    {
      business_id: conn.openId,
      photo_images: imageUrls,
      photo_cover_index: 0,
      post_info: {
        ...postInfo(caption, settings, "photo"),
        title: (title || caption.split("\n")[0] || "").slice(0, 90),
        privacy_level: s?.privacy || "PUBLIC_TO_EVERYONE",
        auto_add_music: true,
      },
    },
    "TikTok-fotopost publiceren",
    conn.accessToken,
  );
  if (!data?.share_id) throw new Error("TikTok-fotopost publiceren: geen id ontvangen");
  await waitForPublish(conn, data.share_id);
  return { id: data.share_id };
}
