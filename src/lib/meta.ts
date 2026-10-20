import { kvGet, kvUpdate } from "./store";
import { APP_URL } from "./config";
import { publishIgMedia, type IgPlacement } from "./ig-media";
import { fetchJson, MEDIA_TIMEOUT_MS } from "./http";
import {
  DAY_MS,
  errorText,
  toHealth,
  type ChannelHealth,
  type TokenHealthFields,
} from "./token-status";

/* ---------------- Config ---------------- */

export const META = {
  appId: process.env.META_APP_ID || "",
  appSecret: process.env.META_APP_SECRET || "",
  // v21.0 t/m v24.0 zijn (okt 2026) deprecated: Meta upgradet die calls automatisch
  // naar v25.0 (header x-ad-api-version-warning). META_GRAPH_VERSION blijft een override.
  graph: process.env.META_GRAPH_VERSION || "v25.0",
  appUrl: APP_URL,
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
  const data = await fetchJson<{ access_token?: string }>(
    graphUrl(`/oauth/access_token?${params}`),
    {},
    { label: "Token-uitwisseling" },
  );
  if (!data.access_token) throw new Error("Token-uitwisseling mislukt");
  return data.access_token;
}

/**
 * Wissel kortlevend token in voor een langlevend token (~60 dagen).
 * `expiresAt` (ms) komt uit `expires_in`; ontbreekt als Meta die niet meestuurt.
 */
export async function getLongLivedToken(
  shortToken: string,
): Promise<{ token: string; expiresAt?: number }> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: META.appId,
    client_secret: META.appSecret,
    fb_exchange_token: shortToken,
  });
  const data = await fetchJson<{ access_token?: string; expires_in?: number }>(
    graphUrl(`/oauth/access_token?${params}`),
    {},
    { label: "Long-lived token" },
  );
  if (!data.access_token) throw new Error("Long-lived token mislukt");
  return {
    token: data.access_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/* ---------------- Pagina's + Instagram ---------------- */

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  instagram?: { id: string; username: string };
  /** Uit debug_token: verloopmoment pagina-token (ms); 0 = verloopt nooit. */
  expiresAt?: number;
  /** Uit debug_token: data_access_expires_at (ms); 0 = onbekend/nooit. */
  dataAccessExpiresAt?: number;
  /** Laatste debug_token-controle van deze pagina (ms). */
  checkedAt?: number;
}

interface PagesResponse {
  data?: {
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username: string };
  }[];
  paging?: { next?: string };
}

/** Max. aantal vervolgpagina's (à 100) dat we volgen. */
const MAX_PAGE_REQUESTS = 10;

/**
 * Alle Facebook-pagina's waar de gebruiker bij inloggen toegang toe gaf
 * (limit=100, volgt paging.next). Het token gaat via URLSearchParams mee.
 */
export async function fetchPages(userToken: string): Promise<MetaPage[]> {
  const params = new URLSearchParams({
    fields: "id,name,access_token,instagram_business_account{id,username}",
    limit: "100",
    access_token: userToken,
  });
  const graphBase = `https://graph.facebook.com/`;
  const out: MetaPage[] = [];
  const seen = new Set<string>();
  let url: string | undefined = graphUrl(`/me/accounts?${params}`);
  for (let i = 0; url && i < MAX_PAGE_REQUESTS; i++) {
    const data: PagesResponse = await fetchJson<PagesResponse>(url, {}, {
      label: "Pagina's ophalen",
    });
    for (const p of data.data || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
        instagram: p.instagram_business_account
          ? {
              id: p.instagram_business_account.id,
              username: p.instagram_business_account.username,
            }
          : undefined,
      });
    }
    const next = data.paging?.next;
    // Alleen vervolg-URL's van de Graph API zelf volgen.
    url = next && next.startsWith(graphBase) && data.data?.length ? next : undefined;
  }
  return out;
}

/** Rechten die nodig zijn om te kunnen posten; geweigerd → koppeling afwijzen. */
export const REQUIRED_META_PERMISSIONS = [
  "pages_manage_posts",
  "instagram_content_publish",
];

/**
 * Lees-only: GET /me/permissions. Geeft de vereiste rechten terug die NIET
 * verleend zijn (geweigerd/verlopen of ontbrekend). `null` als de lijst niet
 * op te halen was — dan blokkeren we niet.
 */
export async function missingMetaPermissions(userToken: string): Promise<string[] | null> {
  const params = new URLSearchParams({ access_token: userToken, limit: "100" });
  try {
    const data = await fetchJson<{ data?: { permission: string; status: string }[] }>(
      graphUrl(`/me/permissions?${params}`),
      {},
      { label: "Rechten controleren", timeoutMs: 8000 },
    );
    const list = data.data || [];
    if (!list.length) return null;
    const granted = new Set(
      list.filter((x) => x.status === "granted").map((x) => x.permission),
    );
    return REQUIRED_META_PERMISSIONS.filter((p) => !granted.has(p));
  } catch {
    return null;
  }
}

/* ---------------- Token-opslag (lokaal JSON-bestand) ---------------- */

export interface MetaStore extends TokenHealthFields {
  userToken: string;
  pages: MetaPage[];
  obtainedAt: number;
  /** Welke pagina dit account gebruikt om te posten. */
  selectedPageId?: string;
  /**
   * Gezet bij koppelingen via de (nieuwe) callback: dan postten we alleen naar
   * een expliciet gekozen pagina (of de enige). Oude koppelingen zonder deze
   * vlag vallen terug op de eerste pagina, zodat die blijven werken.
   */
  explicitPageRequired?: boolean;
  /** Verloopmoment van het langlevende user-token (ms), uit expires_in. */
  userTokenExpiresAt?: number;
  // expiresAt (TokenHealthFields) = eerstvolgende relevante verloopdatum van de
  // actieve pagina (pagina-token of data access), gezet na een debug_token-check.
}

/** Melding als er (nog) geen pagina gekozen is. */
export const PAGE_CHOICE_REQUIRED = "Kies eerst een Facebook-pagina op Verbindingen";

/**
 * De pagina waarmee dit account post. Facebook geeft alle pagina's terug waar je
 * toegang toe hebt, dus zonder expliciete keuze zou een account naar de verkeerde
 * pagina kunnen posten.
 * - Gekozen pagina (selectedPageId) bestaat → die.
 * - Nieuwe koppeling (explicitPageRequired): alleen als er precies 1 pagina is.
 * - Oude koppeling zonder vlag: de eerste pagina (ongewijzigd gedrag).
 */
export function activePage(store: MetaStore | null): MetaPage | undefined {
  if (!store) return undefined;
  const chosen = store.pages.find((p) => p.id === store.selectedPageId);
  if (chosen) return chosen;
  if (store.explicitPageRequired) {
    return store.pages.length === 1 ? store.pages[0] : undefined;
  }
  return store.pages[0];
}

/** Er zijn pagina's, maar er moet er eerst één gekozen worden. */
export function needsPageChoice(store: MetaStore | null): boolean {
  return Boolean(store && store.pages.length > 0 && !activePage(store));
}

/**
 * Oude koppeling die stilzwijgend op de eerste pagina terugvalt terwijl er
 * meerdere zijn → UI toont 'Kies expliciet een pagina'.
 */
export function implicitPageFallback(store: MetaStore | null): boolean {
  if (!store || store.pages.length <= 1) return false;
  return !store.pages.some((p) => p.id === store.selectedPageId);
}

/** Tokens per account-id: { [accountId]: MetaStore }. */
type MetaStoreMap = Record<string, MetaStore>;

const TOKENS_KEY = "meta-tokens";

async function readAll(): Promise<MetaStoreMap> {
  return (await kvGet<MetaStoreMap>(TOKENS_KEY)) ?? {};
}

/** Read-modify-write van de hele map onder `lock:meta-tokens`. */
function updateAll(fn: (map: MetaStoreMap) => void): Promise<MetaStoreMap> {
  return kvUpdate<MetaStoreMap>(TOKENS_KEY, (cur) => {
    const map = cur ?? {};
    fn(map);
    return map;
  });
}

export async function saveMetaStore(
  accountId: string,
  store: MetaStore,
): Promise<void> {
  await updateAll((map) => {
    map[accountId] = store;
  });
}

export async function loadMetaStore(
  accountId: string,
): Promise<MetaStore | null> {
  const map = await readAll();
  return map[accountId] || null;
}

export async function clearMetaStore(accountId: string): Promise<void> {
  await updateAll((map) => {
    delete map[accountId];
  });
}

/** Kies met welke pagina dit account post. */
export async function setSelectedPage(
  accountId: string,
  pageId: string,
): Promise<boolean> {
  let ok = false;
  await updateAll((map) => {
    const store = map[accountId];
    if (!store || !store.pages.some((p) => p.id === pageId)) return;
    store.selectedPageId = pageId;
    // expiresAt hoort bij de vorige pagina; de volgende check vult 'm opnieuw
    store.expiresAt = relevantExpiry(activePage(store));
    ok = true;
  });
  return ok;
}

/* ---------------- Token-gezondheid ---------------- */

/** Eerstvolgende relevante verloopdatum van een pagina (0/undefined = nooit). */
function relevantExpiry(page: MetaPage | undefined): number | undefined {
  const xs = [page?.expiresAt, page?.dataAccessExpiresAt].filter(
    (x): x is number => typeof x === "number" && x > 0,
  );
  return xs.length ? Math.min(...xs) : undefined;
}

/** Zet de Meta-koppeling van dit account op 'opnieuw verbinden nodig'. */
export async function markMetaNeedsReauth(
  accountId: string,
  lastError: string,
): Promise<void> {
  await updateAll((map) => {
    const store = map[accountId];
    if (!store) return;
    store.status = "needs_reauth";
    store.lastError = lastError;
    store.checkedAt = Date.now();
  });
}

interface DebugTokenData {
  is_valid?: boolean;
  expires_at?: number;
  data_access_expires_at?: number;
  error?: { message?: string; code?: number };
}

/**
 * Lees-only: GET /debug_token voor een (pagina-)token met het app-token.
 * Geeft `null` bij een fout in de aanroep zelf (netwerk, app-config) — dat zegt
 * niets over het token.
 */
async function debugToken(
  inputToken: string,
  timeoutMs = 5000,
): Promise<DebugTokenData | null> {
  if (!metaConfigured()) return null;
  const params = new URLSearchParams({
    input_token: inputToken,
    access_token: `${META.appId}|${META.appSecret}`,
  });
  try {
    const res = await fetchJson<{ data?: DebugTokenData }>(
      graphUrl(`/debug_token?${params}`),
      {},
      { label: "Meta token-controle", timeoutMs },
    );
    return res.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Controleert (lees-only, debug_token) het token van de actieve pagina en slaat
 * expires_at / data_access_expires_at + status op. Zonder `force` alleen als de
 * laatste controle van die pagina ouder is dan 24 uur (of nog nooit gedaan).
 */
export async function checkMetaTokenHealth(
  accountId: string,
  opts: { force?: boolean; store?: MetaStore | null } = {},
): Promise<MetaStore | null> {
  const store = opts.store !== undefined ? opts.store : await loadMetaStore(accountId);
  const page = activePage(store);
  if (!store || !page || !metaConfigured()) return store;
  const now = Date.now();
  if (!opts.force && page.checkedAt && now - page.checkedAt < DAY_MS) return store;

  const info = await debugToken(page.accessToken);
  if (!info) return store; // controle zelf mislukt → status ongewijzigd

  let updated: MetaStore | null = store;
  try {
    const map = await updateAll((map) => {
      const s = map[accountId];
      const p = s?.pages.find((x) => x.id === page.id);
      if (!s || !p) return;
      p.expiresAt = info.expires_at ? info.expires_at * 1000 : 0;
      p.dataAccessExpiresAt = info.data_access_expires_at
        ? info.data_access_expires_at * 1000
        : 0;
      p.checkedAt = now;
      s.checkedAt = now;
      s.expiresAt = relevantExpiry(activePage(s));
      if (info.is_valid === false) {
        s.status = "needs_reauth";
        s.lastError = errorText(
          info.error?.message ? `Facebook: ${info.error.message}` : "Facebook-token is ongeldig",
        );
      } else if (info.is_valid === true) {
        s.status = "ok";
        delete s.lastError;
      }
    });
    updated = map[accountId] ?? null;
  } catch {
    // opslag bezet: volgende keer opnieuw
  }
  return updated;
}

/** Gezondheid van de Meta-koppeling (actieve pagina). Nooit tokens. */
export function metaHealth(store: MetaStore, now = Date.now()): ChannelHealth {
  const page = activePage(store);
  const expiresAt = relevantExpiry(page);
  let lastError = store.lastError;
  if (!lastError && expiresAt && expiresAt <= now) {
    lastError =
      page?.dataAccessExpiresAt === expiresAt
        ? "Facebook-datatoegang verlopen (geldt 90 dagen) — opnieuw verbinden vernieuwt dit"
        : "Facebook-pagina-token verlopen";
  }
  return toHealth(
    { status: store.status, expiresAt, lastError, connectedAt: store.obtainedAt },
    now,
  );
}

/* ---------------- Posten ---------------- */

/** Post tekst, foto of video naar een Facebook-pagina (feed). */
export async function postToFacebookPage(
  page: MetaPage,
  message: string,
  media?: { url: string; kind: "image" | "video" },
): Promise<{ id: string; url: string }> {
  let data: { id?: string; post_id?: string };
  if (media?.kind === "video") {
    // Video → /videos met file_url (Facebook haalt de video zelf op)
    data = await fetchJson(
      graphUrl(`/${page.id}/videos`),
      {
        method: "POST",
        body: new URLSearchParams({
          access_token: page.accessToken,
          file_url: media.url,
          description: message,
        }),
      },
      { label: "Facebook-video", timeoutMs: MEDIA_TIMEOUT_MS },
    );
  } else {
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
    data = await fetchJson(
      endpoint,
      { method: "POST", body },
      { label: "Facebook-post", timeoutMs: media?.url ? 60_000 : undefined },
    );
  }
  const postId = data.post_id || data.id;
  if (!postId) throw new Error("Facebook gaf geen post-id terug");
  return {
    id: data.id || postId,
    url: `https://www.facebook.com/${postId}`,
  };
}

/** Lees-only controle (testmodus): werkt het pagina-token nog? */
export async function checkFacebookPage(page: MetaPage, timeoutMs = 5000): Promise<void> {
  const params = new URLSearchParams({ fields: "id", access_token: page.accessToken });
  await fetchJson(graphUrl(`/${page.id}?${params}`), {}, {
    label: "Facebook-koppeling",
    timeoutMs,
  });
}

/** Lees-only controle (testmodus): kan het pagina-token het IG-account lezen? */
export async function checkInstagramViaPage(
  igId: string,
  pageToken: string,
  timeoutMs = 5000,
): Promise<void> {
  const params = new URLSearchParams({ fields: "username", access_token: pageToken });
  await fetchJson(graphUrl(`/${igId}?${params}`), {}, {
    label: "Instagram-koppeling",
    timeoutMs,
  });
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
  placement: IgPlacement,
): Promise<{ id: string; permalink?: string }> {
  return publishIgMedia({
    base: `https://graph.facebook.com/${META.graph}`,
    igId,
    token: pageToken,
    media,
    caption,
    placement,
  });
}
