import { kvGet, kvSet } from "./store";
import { publishIgMedia } from "./ig-media";

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
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_message || data?.error?.message || "IG token-uitwisseling mislukt");
  }
  return { access_token: data.access_token, user_id: data.user_id };
}

/** Wissel kortlevend token in voor langlevend (~60 dagen). */
export async function igLongLivedToken(shortToken: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: IG.appSecret,
    access_token: shortToken,
  });
  const res = await fetch(
    `https://graph.instagram.com/access_token?${params}`,
  );
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message || "IG long-lived token mislukt");
  }
  return data.access_token as string;
}

export async function igProfile(
  token: string,
): Promise<{ id: string; username: string }> {
  const res = await fetch(
    `https://graph.instagram.com/me?fields=user_id,username&access_token=${token}`,
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "IG profiel ophalen mislukt");
  return { id: String(data.user_id), username: data.username };
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
  placement: "feed" | "story",
): Promise<{ id: string }> {
  return publishIgMedia({
    base: "https://graph.instagram.com",
    igId: conn.igUserId,
    token: conn.token,
    media,
    caption,
    placement,
  });
}
