import { kvGet, kvSet } from "./store";
import { fetchJson, downloadBuffer, MEDIA_TIMEOUT_MS } from "./http";

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
  const data = await fetchJson<Partial<GoogleTokens>>(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: YT.clientId,
        client_secret: YT.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: YT_REDIRECT_URI,
      }),
    },
    { label: "Google token-uitwisseling" },
  );
  if (!data.access_token) throw new Error("Google token-uitwisseling mislukt");
  return data as GoogleTokens;
}

export async function youtubeRefresh(refreshToken: string): Promise<GoogleTokens> {
  const data = await fetchJson<Partial<GoogleTokens>>(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: YT.clientId,
        client_secret: YT.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    { label: "Google token-verversing" },
  );
  if (!data.access_token) throw new Error("Google token-verversing mislukt");
  return data as GoogleTokens;
}

export async function youtubeChannel(
  accessToken: string,
): Promise<{ id: string; title: string }> {
  const data = await fetchJson<{
    items?: { id: string; snippet?: { title?: string } }[];
  }>(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { authorization: `Bearer ${accessToken}` } },
    { label: "YouTube-kanaal ophalen" },
  );
  const ch = data.items?.[0];
  if (!ch) throw new Error("Geen YouTube-kanaal gevonden op dit Google-account");
  return { id: ch.id, title: ch.snippet?.title || "YouTube-kanaal" };
}

/** Lees-only controle (testmodus): werkt het YouTube-token nog? */
export async function checkYouTube(accessToken: string, timeoutMs = 5000): Promise<void> {
  const data = await fetchJson<{ items?: unknown[] }>(
    "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
    { headers: { authorization: `Bearer ${accessToken}` } },
    { label: "YouTube-koppeling", timeoutMs },
  );
  if (!data.items?.length) {
    throw new Error("YouTube-koppeling: geen kanaal gevonden op dit Google-account");
  }
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

/* ---------------- Short / video uploaden ---------------- */

export type YouTubePlacement = "short" | "video";

/** YouTube weigert '<' en '>' in titel en beschrijving. */
const clean = (s: string) => s.replace(/[<>]/g, "").trim();

/** Kort af op tekens (niet halverwege een emoji). */
function cutChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("").trimEnd();
}

/** Kort af op UTF-8 bytes (YouTube: beschrijving max 5000 bytes). */
function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > max) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export function youtubeMetadata(
  title: string,
  description: string,
  placement: YouTubePlacement,
): { title: string; description: string } {
  let t = clean(title) || "Nieuwe video";
  if (placement === "short") {
    // #Shorts in de titel helpt verticale video's als Short te laten verschijnen
    t = /#shorts/i.test(t) ? cutChars(t, 100) : `${cutChars(t, 92)} #Shorts`;
  } else {
    t = cutChars(t, 100);
  }
  return { title: t, description: cutBytes(clean(description), 5000) };
}

export async function postToYouTube(
  conn: YouTubeConnection,
  videoUrl: string,
  title: string,
  description: string,
  placement: YouTubePlacement = "short",
): Promise<{ id: string; url: string; privacyStatus?: string }> {
  const { buffer: video, contentType } = await downloadBuffer(videoUrl, {
    label: "Video ophalen",
  });
  const meta = youtubeMetadata(title, description, placement);

  const metadata = JSON.stringify({
    snippet: { title: meta.title, description: meta.description },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  });

  const boundary = "socialflow-upload";
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([head, video, tail]);

  const data = await fetchJson<{ id?: string; status?: { privacyStatus?: string } }>(
    "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.accessToken}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    },
    { label: "YouTube-upload", timeoutMs: MEDIA_TIMEOUT_MS },
  );
  if (!data.id) throw new Error("YouTube-upload: geen video-id ontvangen");
  return {
    id: data.id,
    url:
      placement === "short"
        ? `https://youtube.com/shorts/${data.id}`
        : `https://www.youtube.com/watch?v=${data.id}`,
    privacyStatus: data.status?.privacyStatus,
  };
}
