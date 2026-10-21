import { kvGet, kvSet, kvUpdate, withLock } from "./store";
import { APP_URL } from "./config";
import { fetchJson, fetchRaw, downloadBuffer, sleep, MEDIA_TIMEOUT_MS, HttpError } from "./http";
import {
  parseTikTokSettings,
  type TikTokCreatorInfo,
  type TikTokPostSettings,
} from "./tiktok-settings";
import {
  REFRESH_LOCK,
  errorText,
  isTransientError,
  toHealth,
  type ChannelHealth,
  type TokenHealthFields,
} from "./token-status";

/* ---------------- Config ---------------- */

export const TIKTOK = {
  clientKey: process.env.TIKTOK_CLIENT_KEY || "",
  clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
  appUrl: APP_URL,
};

export const TIKTOK_REDIRECT_URI = `${TIKTOK.appUrl}/api/auth/tiktok/callback`;
export const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";

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
  /** Looptijd van het refresh-token (s), standaard 365 dagen. */
  refresh_expires_in?: number;
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

export interface TikTokConnection extends TokenHealthFields {
  accessToken: string;
  refreshToken: string;
  /** Verloopmoment van het access-token (ms) — wordt automatisch ververst. */
  expiresAt: number;
  /** Verloopmoment van het refresh-token (ms); daarna opnieuw koppelen. */
  refreshExpiresAt?: number;
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
  await kvUpdate<TikTokStoreMap>(KEY, (cur) => ({ ...(cur ?? {}), [accountId]: conn }));
}

/** Zet de TikTok-koppeling van dit account op 'opnieuw verbinden nodig'. */
export async function markTikTokNeedsReauth(
  accountId: string,
  lastError: string,
): Promise<void> {
  await kvUpdate<TikTokStoreMap>(KEY, (cur) => {
    const map = cur ?? {};
    const c = map[accountId];
    if (c) map[accountId] = { ...c, status: "needs_reauth", lastError, checkedAt: Date.now() };
    return map;
  });
}

const refreshDue = (c: TikTokConnection, now: number) =>
  c.status !== "needs_reauth" && now > c.expiresAt - 5 * 60_000;

/**
 * Laadt de koppeling en ververst het access-token als het (bijna) verlopen is.
 * TikTok roteert het refresh-token: de verversing loopt daarom volledig onder
 * `lock:tiktok-tokens` (opnieuw lezen → verversen → opslaan), zodat parallelle
 * aanvragen (bv. GET /api/accounts) nooit een geroteerd token kwijtraken.
 * Definitieve fout (invalid_grant e.d.) → status needs_reauth + lastError.
 */
export async function loadTikTokConnection(
  accountId: string,
): Promise<TikTokConnection | null> {
  const map = (await kvGet<TikTokStoreMap>(KEY)) ?? {};
  const conn = map[accountId] || null;
  if (!conn) return null;
  if (!refreshDue(conn, Date.now())) return conn;
  try {
    return await withLock(
      `lock:${KEY}`,
      async () => {
        const fresh = (await kvGet<TikTokStoreMap>(KEY)) ?? {};
        const cur = fresh[accountId];
        if (!cur) return null;
        const now = Date.now();
        if (!refreshDue(cur, now)) return cur; // al ververst door een ander
        let updated: TikTokConnection;
        try {
          const t = await tiktokRefresh(cur.refreshToken);
          updated = {
            ...cur,
            accessToken: t.access_token,
            refreshToken: t.refresh_token || cur.refreshToken,
            expiresAt: now + (t.expires_in || 86400) * 1000,
            refreshExpiresAt: t.refresh_expires_in
              ? now + t.refresh_expires_in * 1000
              : cur.refreshExpiresAt,
            checkedAt: now,
            status: "ok",
          };
          delete updated.lastError;
        } catch (e) {
          updated = isTransientError(e)
            ? { ...cur, checkedAt: now, lastError: errorText(e) } // later opnieuw
            : { ...cur, checkedAt: now, status: "needs_reauth", lastError: errorText(e) };
        }
        fresh[accountId] = updated;
        await kvSet(KEY, fresh);
        return updated;
      },
      REFRESH_LOCK,
    );
  } catch {
    return conn; // opslag bezet: laat de post-poging de echte fout tonen
  }
}

/** Lees-only controle (dagelijkse health-run). 401/access_token_invalid → needs_reauth. */
export async function checkTikTokTokenHealth(accountId: string): Promise<void> {
  const conn = await loadTikTokConnection(accountId); // ververst indien nodig
  if (!conn || conn.status === "needs_reauth") return;
  try {
    await tiktokUserInfo(conn.accessToken, { label: "TikTok-koppeling", timeoutMs: 5000 });
  } catch (e) {
    if (
      e instanceof HttpError &&
      (e.code === "access_token_invalid" || e.status === 401)
    ) {
      await markTikTokNeedsReauth(accountId, errorText(e));
    }
  }
}

/** Gezondheid: alleen het refresh-token telt (access-token ververst vanzelf). */
export function tiktokHealth(conn: TikTokConnection, now = Date.now()): ChannelHealth {
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

export async function clearTikTokConnection(accountId: string): Promise<void> {
  await kvUpdate<TikTokStoreMap>(KEY, (cur) => {
    const map = cur ?? {};
    delete map[accountId];
    return map;
  });
}

/* ---------------- Video posten (FILE_UPLOAD) ---------------- */

const MB = 1024 * 1024;
/** TikTok: één chunk tot 64 MB, daarboven chunks van 10 MB (laatste neemt de rest). */
export function tiktokChunkPlan(size: number): { chunkSize: number; total: number } {
  const chunkSize = size <= 64 * MB ? size : 10 * MB;
  const total = Math.max(1, Math.floor(size / chunkSize));
  return { chunkSize, total };
}

/** Gegevens en mogelijkheden van de maker (verplicht vóór Direct Post). */
export async function tiktokCreatorInfo(
  conn: TikTokConnection,
  timeoutMs?: number,
): Promise<TikTokCreatorInfo> {
  const info = await fetchJson<{
    data?: {
      creator_nickname?: string;
      creator_username?: string;
      creator_avatar_url?: string;
      privacy_level_options?: string[];
      comment_disabled?: boolean;
      duet_disabled?: boolean;
      stitch_disabled?: boolean;
      max_video_post_duration_sec?: number;
    };
  }>(
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
      },
    },
    { label: "TikTok creator-info", timeoutMs },
  );
  const d = info.data ?? {};
  return {
    nickname: d.creator_nickname || conn.displayName,
    username: d.creator_username || "",
    avatarUrl: d.creator_avatar_url || "",
    privacyOptions: d.privacy_level_options ?? [],
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxVideoSeconds: d.max_video_post_duration_sec || 0,
  };
}

/** Wat er in post_info meegaat, op basis van de keuzes van de maker. */
interface TikTokPostInfo {
  privacy_level: string;
  disable_comment: boolean;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
}

/**
 * Zet de keuzes van de maker om naar post_info en controleert ze tegen
 * creator_info. Zonder keuzes (oude ingeplande posts) → openbaar als dat mag,
 * reacties aan.
 */
async function resolvePostInfo(
  conn: TikTokConnection,
  raw: unknown,
  kind: "video" | "photo",
): Promise<TikTokPostInfo> {
  const info = await tiktokCreatorInfo(conn);
  const s: TikTokPostSettings | undefined = parseTikTokSettings(raw);
  const options = info.privacyOptions;
  let privacy: string;
  if (s) {
    if (!options.includes(s.privacy)) {
      throw new Error("TikTok: deze zichtbaarheid is voor dit account niet beschikbaar");
    }
    if (s.brandedContent && s.privacy === "SELF_ONLY") {
      throw new Error("TikTok: branded content kan niet op 'Alleen ik' staan");
    }
    privacy = s.privacy;
  } else {
    privacy = options.includes("PUBLIC_TO_EVERYONE")
      ? "PUBLIC_TO_EVERYONE"
      : options[0] ?? "SELF_ONLY";
  }
  const out: TikTokPostInfo = {
    privacy_level: privacy,
    disable_comment: info.commentDisabled || (s ? !s.allowComment : false),
    brand_content_toggle: Boolean(s?.brandedContent),
    brand_organic_toggle: Boolean(s?.yourBrand),
  };
  if (kind === "video") {
    out.disable_duet = info.duetDisabled || (s ? !s.allowDuet : false);
    out.disable_stitch = info.stitchDisabled || (s ? !s.allowStitch : false);
  }
  return out;
}

/**
 * Niet-geaudite apps mogen niet direct openbaar posten (alleen naar privé-accounts).
 * Dan valt SocialFlow terug op 'Upload to TikTok': een concept in de inbox van de maker.
 */
function isUnaudited(e: unknown): boolean {
  return e instanceof HttpError && e.code === "unaudited_client_can_only_post_to_private_accounts";
}

export async function postToTikTok(
  conn: TikTokConnection,
  videoUrl: string,
  caption: string,
  settings?: unknown,
): Promise<{ id: string; draft?: boolean }> {
  // 1. video ophalen (uit onze eigen opslag)
  const { buffer: video, contentType } = await downloadBuffer(videoUrl, {
    label: "Video ophalen",
  });
  const size = video.byteLength;
  if (!size) throw new Error("Video ophalen: leeg bestand");
  const { chunkSize, total } = tiktokChunkPlan(size);

  // 2. creator_info + de keuzes van de maker (verplicht vóór Direct Post)
  const postInfo = await resolvePostInfo(conn, settings, "video");

  // 3. upload initialiseren (zonder Direct Post-audit: als concept naar de inbox)
  const sourceInfo = {
    source: "FILE_UPLOAD",
    video_size: size,
    chunk_size: chunkSize,
    total_chunk_count: total,
  };
  const headers = {
    authorization: `Bearer ${conn.accessToken}`,
    "content-type": "application/json; charset=UTF-8",
  };
  let draft = false;
  let init: { data?: { upload_url?: string; publish_id?: string } };
  try {
    init = await fetchJson(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          post_info: { title: caption.slice(0, 2200), ...postInfo },
          source_info: sourceInfo,
        }),
      },
      { label: "TikTok upload-init" },
    );
  } catch (e) {
    if (!isUnaudited(e)) throw e;
    draft = true;
    init = await fetchJson(
      "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
      { method: "POST", headers, body: JSON.stringify({ source_info: sourceInfo }) },
      { label: "TikTok concept-init" },
    );
  }
  const uploadUrl = init.data?.upload_url;
  const publishId = init.data?.publish_id;
  if (!uploadUrl || !publishId) throw new Error("TikTok upload-init: geen upload-URL ontvangen");

  // 4. video uploaden, chunk voor chunk
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

  return { id: publishId, draft };
}

/* ---------------- Foto('s) posten (PULL_FROM_URL) ---------------- */

/** TikTok: max. 35 foto's per fotopost. */
export const TIKTOK_PHOTO_MAX = 35;

/**
 * Fotopost (1–35 foto's, swipebaar). TikTok haalt de foto's zelf op; de URL's
 * moeten op ons geverifieerde domein staan (APP_URL/api/media/...).
 * Daarna de status volgen tot TikTok de post heeft verwerkt (max ~60 s).
 */
export async function postPhotosToTikTok(
  conn: TikTokConnection,
  imageUrls: string[],
  caption: string,
  title?: string,
  settings?: unknown,
): Promise<{ id: string; draft?: boolean }> {
  if (!imageUrls.length || imageUrls.length > TIKTOK_PHOTO_MAX) {
    throw new Error(`TikTok-fotopost: 1 t/m ${TIKTOK_PHOTO_MAX} foto's nodig`);
  }
  const init = (direct: boolean, postInfo?: TikTokPostInfo) =>
    fetchJson<{ data?: { publish_id?: string } }>(
      "https://open.tiktokapis.com/v2/post/publish/content/init/",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${conn.accessToken}`,
          "content-type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          post_info: {
            title: (title || caption.split("\n")[0] || "").slice(0, 90),
            description: caption.slice(0, 4000),
            ...(direct ? postInfo : {}),
            auto_add_music: true,
          },
          source_info: {
            source: "PULL_FROM_URL",
            photo_cover_index: 0,
            photo_images: imageUrls,
          },
          post_mode: direct ? "DIRECT_POST" : "MEDIA_UPLOAD",
          media_type: "PHOTO",
        }),
      },
      { label: direct ? "TikTok fotopost-init" : "TikTok concept-init" },
    );
  let draft = false;
  let res: { data?: { publish_id?: string } };
  try {
    res = await init(true, await resolvePostInfo(conn, settings, "photo"));
  } catch (e) {
    if (!isUnaudited(e)) throw e;
    // Zonder Direct Post-audit: als concept naar de TikTok-inbox van de maker.
    draft = true;
    res = await init(false);
  }
  const publishId = res.data?.publish_id;
  if (!publishId) throw new Error("TikTok fotopost-init: geen publish-id ontvangen");

  // Ophalen + verwerken gebeurt asynchroon; een mislukking (bv. URL niet
  // bereikbaar) zie je alleen in de status.
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await sleep(4000);
    const st = await fetchJson<{ data?: { status?: string; fail_reason?: string } }>(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${conn.accessToken}`,
          "content-type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
      },
      { label: "TikTok fotopost-status", timeoutMs: 10_000 },
    ).catch(() => null);
    const status = st?.data?.status;
    if (status === "PUBLISH_COMPLETE" || (draft && status === "SEND_TO_USER_INBOX")) break;
    if (status === "FAILED") {
      throw new Error(`TikTok-fotopost mislukt: ${st?.data?.fail_reason || "onbekende reden"}`);
    }
  }
  return { id: publishId, draft };
}
