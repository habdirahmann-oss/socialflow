/**
 * Gedeelde Instagram-publicatielogica voor zowel de Facebook-pagina-route
 * (graph.facebook.com/<versie>) als de losse Instagram-Login-route
 * (graph.instagram.com). Ondersteunt foto's én video's, op feed/reel of story.
 */
import { fetchJson, sleep, HttpError } from "./http";

export interface IgMedia {
  url: string; // PUBLIEKE url (Blob)
  kind: "image" | "video";
}

export type IgPlacement = "feed" | "reel" | "story";

/** Totale wachttijd voor video-verwerking door Instagram. */
const CONTAINER_BUDGET_MS = 150_000;
/**
 * Tijd die na het wachten op de container nog nodig kan zijn: publiceren
 * (15 s), 10 s pauze + herkansing (15 s) en de permalink (10 s).
 */
const AFTER_CONTAINER_MS = 50_000;
/** Poll-intervallen: 3, 5, 8, 8, 8 … s. */
const POLL_INTERVALS_S = [3, 5, 8];

function notReady(e: unknown): boolean {
  return e instanceof HttpError && (e.code === 9007 || e.subcode === 2207027);
}

export async function publishIgMedia(opts: {
  base: string; // host + evt. versie, zonder trailing slash
  igId: string; // Instagram user/business-id
  token: string;
  media: IgMedia;
  caption: string;
  placement: IgPlacement;
  /** Uiterste tijdstip (epoch ms) waarop alles klaar moet zijn (function-timeout). */
  deadline?: number;
}): Promise<{ id: string; permalink?: string }> {
  const { base, igId, token, media, caption, placement, deadline } = opts;
  const isStory = placement === "story";
  const isVideo = media.kind === "video";

  const createBody = new URLSearchParams({ access_token: token });
  if (isVideo) createBody.set("video_url", media.url);
  else createBody.set("image_url", media.url);

  // media_type: story = STORIES, video (feed/reel) = REELS, foto-feed = (geen)
  if (isStory) createBody.set("media_type", "STORIES");
  else if (isVideo) createBody.set("media_type", "REELS");

  // caption hoort niet bij stories
  if (!isStory) createBody.set("caption", caption);

  const created = await fetchJson<{ id?: string }>(
    `${base}/${igId}/media`,
    { method: "POST", body: createBody },
    { label: "IG media-container" },
  );
  if (!created.id) throw new Error("IG media-container: geen id ontvangen");

  // Video's worden asynchroon verwerkt → wachten tot de container klaar is.
  if (isVideo) {
    const budget = deadline
      ? Math.min(CONTAINER_BUDGET_MS, deadline - Date.now() - AFTER_CONTAINER_MS)
      : CONTAINER_BUDGET_MS;
    await waitForContainer(base, created.id, token, budget);
  }

  const publish = () =>
    fetchJson<{ id?: string }>(
      `${base}/${igId}/media_publish`,
      {
        method: "POST",
        body: new URLSearchParams({ creation_id: created.id!, access_token: token }),
      },
      { label: "IG publiceren" },
    );
  let published: { id?: string };
  try {
    published = await publish();
  } catch (e) {
    // "media nog niet klaar" → 10 s wachten en één keer opnieuw.
    if (!notReady(e)) throw e;
    if (deadline && Date.now() + 25_000 > deadline) {
      throw new Error("IG publiceren: video nog niet klaar en geen tijd meer voor een herkansing");
    }
    await sleep(10_000);
    published = await publish();
  }
  if (!published.id) throw new Error("IG publiceren: geen media-id ontvangen");

  // Permalink ophalen; mislukken is geen probleem (de post staat er al).
  let permalink: string | undefined;
  try {
    const info = await fetchJson<{ permalink?: string }>(
      `${base}/${published.id}?${new URLSearchParams({ fields: "permalink", access_token: token })}`,
      {},
      { label: "IG permalink", timeoutMs: 10_000 },
    );
    permalink = typeof info.permalink === "string" ? info.permalink : undefined;
  } catch {
    permalink = undefined;
  }
  return { id: published.id, permalink };
}

/** Instagram: max. 10 items per carrousel. */
export const IG_CAROUSEL_MAX = 10;

/**
 * Carrousel (2–10 foto's) in de feed: per foto een child-container
 * (is_carousel_item), daarna één CAROUSEL-container met de caption en publiceren.
 */
export async function publishIgCarousel(opts: {
  base: string;
  igId: string;
  token: string;
  imageUrls: string[];
  caption: string;
}): Promise<{ id: string; permalink?: string }> {
  const { base, igId, token, imageUrls, caption } = opts;
  if (imageUrls.length < 2 || imageUrls.length > IG_CAROUSEL_MAX) {
    throw new Error(`IG-carrousel: 2 t/m ${IG_CAROUSEL_MAX} foto's nodig`);
  }
  const children: string[] = [];
  for (const [i, url] of imageUrls.entries()) {
    const child = await fetchJson<{ id?: string }>(
      `${base}/${igId}/media`,
      {
        method: "POST",
        body: new URLSearchParams({
          access_token: token,
          image_url: url,
          is_carousel_item: "true",
        }),
      },
      { label: `IG carrousel-foto ${i + 1}` },
    );
    if (!child.id) throw new Error(`IG carrousel-foto ${i + 1}: geen id ontvangen`);
    children.push(child.id);
  }

  const parent = await fetchJson<{ id?: string }>(
    `${base}/${igId}/media`,
    {
      method: "POST",
      body: new URLSearchParams({
        access_token: token,
        media_type: "CAROUSEL",
        children: children.join(","),
        caption,
      }),
    },
    { label: "IG carrousel-container" },
  );
  if (!parent.id) throw new Error("IG carrousel-container: geen id ontvangen");
  await waitForContainer(base, parent.id, token, 60_000);

  const published = await fetchJson<{ id?: string }>(
    `${base}/${igId}/media_publish`,
    {
      method: "POST",
      body: new URLSearchParams({ creation_id: parent.id, access_token: token }),
    },
    { label: "IG publiceren" },
  );
  if (!published.id) throw new Error("IG publiceren: geen media-id ontvangen");

  let permalink: string | undefined;
  try {
    const info = await fetchJson<{ permalink?: string }>(
      `${base}/${published.id}?${new URLSearchParams({ fields: "permalink", access_token: token })}`,
      {},
      { label: "IG permalink", timeoutMs: 10_000 },
    );
    permalink = typeof info.permalink === "string" ? info.permalink : undefined;
  } catch {
    permalink = undefined;
  }
  return { id: published.id, permalink };
}

/** Poll de container-status tot FINISHED, binnen een budget (max 150 s). */
async function waitForContainer(
  base: string,
  containerId: string,
  token: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const qs = new URLSearchParams({ fields: "status_code,status", access_token: token });
  let last = "onbekend";
  for (let i = 0; ; i++) {
    const wait = POLL_INTERVALS_S[Math.min(i, POLL_INTERVALS_S.length - 1)] * 1000;
    if (Date.now() + wait > deadline) break;
    await sleep(wait);

    // fetchJson gooit direct bij !res.ok of data.error → echte melding.
    const data = await fetchJson<{ status_code?: string; status?: string }>(
      `${base}/${containerId}?${qs}`,
      {},
      { label: "IG-videostatus" },
    );
    const code = data.status_code;
    last = [code, data.status].filter(Boolean).join(" — ") || "onbekend";
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`IG-videoverwerking mislukt: ${last}`);
    }
  }
  throw new Error(
    `IG-videoverwerking duurde te lang (>${Math.round(Math.max(0, budgetMs) / 1000)}s, laatste status: ${last}). Er is niets geplaatst.`,
  );
}
