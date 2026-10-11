import { kvGet, kvSet } from "./store";

/* ---------------- Config ---------------- */

export const YT = {
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  appUrl: process.env.APP_URL || "http://localhost:3000",
};

export const YT_REDIRECT_URI = `${YT.appUrl}/api/auth/youtube/callback`;
export const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

export function youtubeConfigured(): boolean {
  return Boolean(YT.clientId && YT.clientSecret);
}

/* ---------------- OAuth ---------------- */

export function youtubeLoginUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: YT.clientId,
    redirect_uri: YT_REDIRECT_URI,
    response_type: "code",
    scope: YT_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function youtubeExchangeCode(code: string): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YT.clientId,
      client_secret: YT.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: YT_REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_description || "Google token-uitwisseling mislukt");
  }
  return data as GoogleTokens;
}

export async function youtubeRefresh(refreshToken: string): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YT.clientId,
      client_secret: YT.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_description || "Google token-verversing mislukt");
  }
  return data as GoogleTokens;
}

export async function youtubeChannel(
  accessToken: string,
): Promise<{ id: string; title: string }> {
  const res = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "YouTube-kanaal ophalen mislukt");
  const ch = data?.items?.[0];
  if (!ch) throw new Error("Geen YouTube-kanaal gevonden op dit Google-account");
  return { id: ch.id, title: ch.snippet?.title || "YouTube-kanaal" };
}

/* ---------------- Opslag per account ---------------- */

export interface YouTubeConnection {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  channelId: string;
  channelTitle: string;
  obtainedAt: number;
}

type YtStoreMap = Record<string, YouTubeConnection>;
const KEY = "youtube-tokens";

export async function saveYouTubeConnection(
  accountId: string,
  conn: YouTubeConnection,
): Promise<void> {
  const map = (await kvGet<YtStoreMap>(KEY)) ?? {};
  map[accountId] = conn;
  await kvSet(KEY, map);
}

export async function loadYouTubeConnection(
  accountId: string,
): Promise<YouTubeConnection | null> {
  const map = (await kvGet<YtStoreMap>(KEY)) ?? {};
  const conn = map[accountId] || null;
  if (!conn) return null;
  if (Date.now() > conn.expiresAt - 5 * 60_000 && conn.refreshToken) {
    try {
      const t = await youtubeRefresh(conn.refreshToken);
      const updated: YouTubeConnection = {
        ...conn,
        accessToken: t.access_token,
        expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
      };
      map[accountId] = updated;
      await kvSet(KEY, map);
      return updated;
    } catch {
      return conn;
    }
  }
  return conn;
}

export async function clearYouTubeConnection(accountId: string): Promise<void> {
  const map = (await kvGet<YtStoreMap>(KEY)) ?? {};
  delete map[accountId];
  await kvSet(KEY, map);
}

/* ---------------- Short uploaden ---------------- */

export async function postToYouTube(
  conn: YouTubeConnection,
  videoUrl: string,
  title: string,
  description: string,
): Promise<{ id: string }> {
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error("Video kon niet worden opgehaald");
  const video = Buffer.from(await videoRes.arrayBuffer());

  // #Shorts in titel/beschrijving zorgt dat verticale video's als Short verschijnen
  const shortTitle = title.includes("#Shorts")
    ? title.slice(0, 100)
    : `${title.slice(0, 90)} #Shorts`;

  const metadata = JSON.stringify({
    snippet: { title: shortTitle, description },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  });

  const boundary = "socialflow-upload";
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: video/mp4\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([head, video, tail]);

  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.accessToken}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    },
  );
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(data?.error?.message || "YouTube-upload mislukt");
  }
  return { id: data.id };
}
