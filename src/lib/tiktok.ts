import { kvGet, kvSet } from "./store";
import { fetchJson, fetchRaw, downloadBuffer, MEDIA_TIMEOUT_MS } from "./http";

/* ---------------- Config ---------------- */

export const TIKTOK = {
  clientKey: process.env.TIKTOK_CLIENT_KEY || "",
  clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
  appUrl: process.env.APP_URL || "http://localhost:3000",
};

export const TIKTOK_REDIRECT_URI = `${TIKTOK.appUrl}/api/auth/tiktok/callback`;
export const TIKTOK_SCOPES = "user.info.basic,video.publish";

export function tiktokConfigured(): boolean {
  return Boolean(TIKTOK.clientKey && TIKTOK.clientSecret);
}

/* ---------------- OAuth v2 ---------------- */

export function tiktokLoginUrl(state: string): string {
  const params = new URLSearchParams({
    client_key: TIKTOK.clientKey,
    scope: TIKTOK_SCOPES,
    response_type: "code",
    redirect_uri: TIKTOK_REDIRECT_URI,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

interface TikTokTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  open_id: string;
}

export async function tiktokExchangeCode(code: string): Promise<TikTokTokens> {
  const data = await fetchJson<Partial<TikTokTokens>>(
    "https://open.tiktokapis.com/v2/oauth/token/",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TIKTOK.clientKey,
        client_secret: TIKTOK.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: TIKTOK_REDIRECT_URI,
      }),
    },
    { label: "TikTok token-uitwisseling" },
  );
  if (!data.access_token) throw new Error("TikTok token-uitwisseling mislukt");
  return data as TikTokTokens;
}

export async function tiktokRefresh(refreshToken: string): Promise<TikTokTokens> {
  const data = await fetchJson<Partial<TikTokTokens>>(
    "https://open.tiktokapis.com/v2/oauth/token/",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TIKTOK.clientKey,
        client_secret: TIKTOK.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    { label: "TikTok token-verversing" },
  );
  if (!data.access_token) throw new Error("TikTok token-verversing mislukt");
  return data as TikTokTokens;
}

export async function tiktokUserInfo(
  accessToken: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<{ openId: string; displayName: string }> {
  const data = await fetchJson<{
    data?: { user?: { open_id?: string; display_name?: string } };
  }>(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
    { headers: { authorization: `Bearer ${accessToken}` } },
    { label: opts.label || "TikTok-profiel ophalen", timeoutMs: opts.timeoutMs },
  );
  return {
    openId: data?.data?.user?.open_id || "",
    displayName: data?.data?.user?.display_name || "TikTok-account",
  };
}

/* ---------------- Opslag per account ---------------- */

export interface TikTokConnection {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  openId: string;
  displayName: string;
  obtainedAt: number;
}

type TikTokStoreMap = Record<string, TikTokConnection>;
const KEY = "tiktok-tokens";

export async function saveTikTokConnection(
  accountId: string,
  conn: TikTokConnection,
): Promise<void> {
  const map = (await kvGet<TikTokStoreMap>(KEY)) ?? {};
  map[accountId] = conn;
  await kvSet(KEY, map);
}

export async function loadTikTokConnection(
  accountId: string,
): Promise<TikTokConnection | null> {
  const map = (await kvGet<TikTokStoreMap>(KEY)) ?? {};
  const conn = map[accountId] || null;
  if (!conn) return null;
  // ververs indien (bijna) verlopen
  if (Date.now() > conn.expiresAt - 5 * 60_000) {
    try {
      const t = await tiktokRefresh(conn.refreshToken);
      const updated: TikTokConnection = {
        ...conn,
        accessToken: t.access_token,
        refreshToken: t.refresh_token || conn.refreshToken,
        expiresAt: Date.now() + (t.expires_in || 86400) * 1000,
      };
      map[accountId] = updated;
      await kvSet(KEY, map);
      return updated;
    } catch {
      return conn; // laat de post-poging de echte fout tonen
    }
  }
  return conn;
}

export async function clearTikTokConnection(accountId: string): Promise<void> {
  const map = (await kvGet<TikTokStoreMap>(KEY)) ?? {};
  delete map[accountId];
  await kvSet(KEY, map);
}

/* ---------------- Video posten (FILE_UPLOAD) ---------------- */

const MB = 1024 * 1024;
/** TikTok: één chunk tot 64 MB, daarboven chunks van 10 MB (laatste neemt de rest). */
export function tiktokChunkPlan(size: number): { chunkSize: number; total: number } {
  const chunkSize = size <= 64 * MB ? size : 10 * MB;
  const total = Math.max(1, Math.floor(size / chunkSize));
  return { chunkSize, total };
}

export async function postToTikTok(
  conn: TikTokConnection,
  videoUrl: string,
  caption: string,
): Promise<{ id: string }> {
  // 1. video ophalen (uit onze eigen opslag)
  const { buffer: video, contentType } = await downloadBuffer(videoUrl, {
    label: "Video ophalen",
  });
  const size = video.byteLength;
  if (!size) throw new Error("Video ophalen: leeg bestand");
  const { chunkSize, total } = tiktokChunkPlan(size);

  // 2. upload initialiseren
  const init = await fetchJson<{ data?: { upload_url?: string; publish_id?: string } }>(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: "SELF_ONLY", // sandbox: alleen privé; na audit PUBLIC_TO_EVERYONE
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: size,
          chunk_size: chunkSize,
          total_chunk_count: total,
        },
      }),
    },
    { label: "TikTok upload-init" },
  );
  const uploadUrl = init.data?.upload_url;
  const publishId = init.data?.publish_id;
  if (!uploadUrl || !publishId) throw new Error("TikTok upload-init: geen upload-URL ontvangen");

  // 3. video uploaden, chunk voor chunk
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = i === total - 1 ? size - 1 : start + chunkSize - 1;
    await fetchRaw(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          "content-type": contentType,
          "content-range": `bytes ${start}-${end}/${size}`,
        },
        body: new Uint8Array(video.subarray(start, end + 1)),
      },
      {
        label: total > 1 ? `TikTok video-upload (deel ${i + 1}/${total})` : "TikTok video-upload",
        timeoutMs: MEDIA_TIMEOUT_MS,
      },
    );
  }

  return { id: publishId };
}
