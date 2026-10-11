import { kvGet, kvSet } from "./store";

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
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: TIKTOK.clientKey,
      client_secret: TIKTOK.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: TIKTOK_REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || "TikTok token-uitwisseling mislukt");
  }
  return data as TikTokTokens;
}

export async function tiktokRefresh(refreshToken: string): Promise<TikTokTokens> {
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: TIKTOK.clientKey,
      client_secret: TIKTOK.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_description || "TikTok token-verversing mislukt");
  }
  return data as TikTokTokens;
}

export async function tiktokUserInfo(
  accessToken: string,
): Promise<{ openId: string; displayName: string }> {
  const res = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "TikTok-profiel ophalen mislukt");
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

export async function postToTikTok(
  conn: TikTokConnection,
  videoUrl: string,
  caption: string,
): Promise<{ id: string }> {
  // 1. video ophalen (uit onze eigen opslag)
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error("Video kon niet worden opgehaald");
  const video = Buffer.from(await videoRes.arrayBuffer());
  const size = video.byteLength;

  // 2. upload initialiseren
  const initRes = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: "SELF_ONLY", // sandbox: alleen privé; na audit PUBLIC_TO_EVERYONE
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: size,
          chunk_size: size,
          total_chunk_count: 1,
        },
      }),
    },
  );
  const init = await initRes.json();
  if (!initRes.ok || !init?.data?.upload_url) {
    throw new Error(init?.error?.message || "TikTok upload-init mislukt");
  }

  // 3. video uploaden
  const putRes = await fetch(init.data.upload_url, {
    method: "PUT",
    headers: {
      "content-type": "video/mp4",
      "content-range": `bytes 0-${size - 1}/${size}`,
    },
    body: new Uint8Array(video),
  });
  if (!putRes.ok) throw new Error(`TikTok video-upload mislukt (${putRes.status})`);

  return { id: init.data.publish_id };
}
