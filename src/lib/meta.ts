import { kvGet, kvSet } from "./store";
import { publishIgMedia } from "./ig-media";

/* ---------------- Config ---------------- */

export const META = {
  appId: process.env.META_APP_ID || "",
  appSecret: process.env.META_APP_SECRET || "",
  graph: process.env.META_GRAPH_VERSION || "v21.0",
  appUrl: process.env.APP_URL || "http://localhost:3000",
};

export const META_REDIRECT_URI = `${META.appUrl}/api/auth/meta/callback`;

/** Rechten die we vragen om naar Facebook-pagina én Instagram te kunnen posten. */
export const META_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
].join(",");

export function metaConfigured(): boolean {
  return Boolean(META.appId && META.appSecret);
}

function graphUrl(p: string): string {
  return `https://graph.facebook.com/${META.graph}${p}`;
}

/* ---------------- OAuth ---------------- */

export function metaLoginUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: META.appId,
    redirect_uri: META_REDIRECT_URI,
    state,
    scope: META_SCOPES,
    response_type: "code",
  });
  return `https://www.facebook.com/${META.graph}/dialog/oauth?${params}`;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: META.appId,
    client_secret: META.appSecret,
    redirect_uri: META_REDIRECT_URI,
    code,
  });
  const res = await fetch(graphUrl(`/oauth/access_token?${params}`));
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message || "Token-uitwisseling mislukt");
  }
  return data.access_token as string;
}

/** Wissel kortlevend token in voor een langlevend token (~60 dagen). */
export async function getLongLivedToken(shortToken: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: META.appId,
    client_secret: META.appSecret,
    fb_exchange_token: shortToken,
  });
  const res = await fetch(graphUrl(`/oauth/access_token?${params}`));
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message || "Long-lived token mislukt");
  }
  return data.access_token as string;
}

/* ---------------- Pagina's + Instagram ---------------- */

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  instagram?: { id: string; username: string };
}

export async function fetchPages(userToken: string): Promise<MetaPage[]> {
  const fields =
    "id,name,access_token,instagram_business_account{id,username}";
  const res = await fetch(
    graphUrl(`/me/accounts?fields=${fields}&access_token=${userToken}`),
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Pagina's ophalen mislukt");
  }
  return (data.data || []).map(
    (p: {
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string; username: string };
    }) => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      instagram: p.instagram_business_account
        ? {
            id: p.instagram_business_account.id,
            username: p.instagram_business_account.username,
          }
        : undefined,
    }),
  );
}

/* ---------------- Token-opslag (lokaal JSON-bestand) ---------------- */

export interface MetaStore {
  userToken: string;
  pages: MetaPage[];
  obtainedAt: number;
  /** Welke pagina dit account gebruikt om te posten. Leeg = de eerste. */
  selectedPageId?: string;
}

/**
 * De pagina waarmee dit account post. Facebook geeft alle pagina's terug waar je
 * toegang toe hebt, dus zonder expliciete keuze zou een account naar de verkeerde
 * pagina kunnen posten. Valt terug op de eerste pagina.
 */
export function activePage(store: MetaStore | null): MetaPage | undefined {
  if (!store) return undefined;
  return (
    store.pages.find((p) => p.id === store.selectedPageId) ?? store.pages[0]
  );
}

/** Tokens per account-id: { [accountId]: MetaStore }. */
type MetaStoreMap = Record<string, MetaStore>;

const TOKENS_KEY = "meta-tokens";

async function readAll(): Promise<MetaStoreMap> {
  return (await kvGet<MetaStoreMap>(TOKENS_KEY)) ?? {};
}

async function writeAll(map: MetaStoreMap): Promise<void> {
  await kvSet(TOKENS_KEY, map);
}

export async function saveMetaStore(
  accountId: string,
  store: MetaStore,
): Promise<void> {
  const map = await readAll();
  map[accountId] = store;
  await writeAll(map);
}

export async function loadMetaStore(
  accountId: string,
): Promise<MetaStore | null> {
  const map = await readAll();
  return map[accountId] || null;
}

export async function clearMetaStore(accountId: string): Promise<void> {
  const map = await readAll();
  delete map[accountId];
  await writeAll(map);
}

/** Kies met welke pagina dit account post. */
export async function setSelectedPage(
  accountId: string,
  pageId: string,
): Promise<boolean> {
  const map = await readAll();
  const store = map[accountId];
  if (!store || !store.pages.some((p) => p.id === pageId)) return false;
  store.selectedPageId = pageId;
  await writeAll(map);
  return true;
}

/* ---------------- Posten ---------------- */

/** Post tekst, foto of video naar een Facebook-pagina (feed). */
export async function postToFacebookPage(
  page: MetaPage,
  message: string,
  media?: { url: string; kind: "image" | "video" },
): Promise<{ id: string }> {
  // Video → /videos met file_url
  if (media?.kind === "video") {
    const body = new URLSearchParams({
      access_token: page.accessToken,
      file_url: media.url,
      description: message,
    });
    const res = await fetch(graphUrl(`/${page.id}/videos`), {
      method: "POST",
      body,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "Facebook-video mislukt");
    return { id: data.id };
  }

  // Foto of tekst
  const endpoint = media?.url
    ? graphUrl(`/${page.id}/photos`)
    : graphUrl(`/${page.id}/feed`);
  const body = new URLSearchParams({ access_token: page.accessToken });
  if (media?.url) {
    body.set("url", media.url);
    body.set("caption", message);
  } else {
    body.set("message", message);
  }
  const res = await fetch(endpoint, { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Facebook-post mislukt");
  return { id: data.id || data.post_id };
}

/**
 * Post foto of video naar Instagram (feed/reel of story) via de Facebook-pagina.
 * Vereist een PUBLIEKE media-URL. Zie ig-media.ts voor de gedeelde logica.
 */
export async function postToInstagram(
  igId: string,
  pageToken: string,
  media: { url: string; kind: "image" | "video" },
  caption: string,
  placement: "feed" | "story",
): Promise<{ id: string }> {
  return publishIgMedia({
    base: `https://graph.facebook.com/${META.graph}`,
    igId,
    token: pageToken,
    media,
    caption,
    placement,
  });
}
