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
}): Promise<{ id: string; permalink?: string }> {
  const { base, igId, token, media, caption, placement } = opts;
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
  if (isVideo) await waitForContainer(base, created.id, token);

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

/** Poll de container-status tot FINISHED, binnen een budget van 150 s. */
async function waitForContainer(
  base: string,
  containerId: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + CONTAINER_BUDGET_MS;
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
    `IG-videoverwerking duurde te lang (>${CONTAINER_BUDGET_MS / 1000}s, laatste status: ${last})`,
  );
}
