import { kvGet, kvSet } from "./store";
import { publishIgMedia, type IgPlacement } from "./ig-media";
import { fetchJson } from "./http";

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
export async function igLongLivedToken(shortToken: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: IG.appSecret,
    access_token: shortToken,
  });
  const data = await fetchJson<{ access_token?: string }>(
    `https://graph.instagram.com/access_token?${params}`,
    {},
    { label: "IG long-lived token" },
  );
  if (!data.access_token) throw new Error("IG long-lived token mislukt");
  return data.access_token;
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

export interface IgConnection {
  token: string;
  igUserId: string;
  username: string;
  obtainedAt: number;
}

type IgStoreMap = Record<string, IgConnection>;
const IG_KEY = "ig-tokens";

export async function saveIgConnection(
  accountId: string,
  conn: IgConnection,
): Promise<void> {
  const map = (await kvGet<IgStoreMap>(IG_KEY)) ?? {};
  map[accountId] = conn;
  await kvSet(IG_KEY, map);
}

export async function loadIgConnection(
  accountId: string,
): Promise<IgConnection | null> {
  const map = (await kvGet<IgStoreMap>(IG_KEY)) ?? {};
  return map[accountId] || null;
}

export async function clearIgConnection(accountId: string): Promise<void> {
  const map = (await kvGet<IgStoreMap>(IG_KEY)) ?? {};
  delete map[accountId];
  await kvSet(IG_KEY, map);
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
