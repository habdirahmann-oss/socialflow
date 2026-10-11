/**
 * Gedeelde Instagram-publicatielogica voor zowel de Facebook-pagina-route
 * (graph.facebook.com/<versie>) als de losse Instagram-Login-route
 * (graph.instagram.com). Ondersteunt foto's én video's, op feed/reel of story.
 */

export interface IgMedia {
  url: string; // PUBLIEKE url (Blob)
  kind: "image" | "video";
}

export async function publishIgMedia(opts: {
  base: string; // host + evt. versie, zonder trailing slash
  igId: string; // Instagram user/business-id
  token: string;
  media: IgMedia;
  caption: string;
  placement: "feed" | "story";
}): Promise<{ id: string }> {
  const { base, igId, token, media, caption, placement } = opts;
  const isStory = placement === "story";
  const isVideo = media.kind === "video";

  const createBody = new URLSearchParams({ access_token: token });
  if (isVideo) createBody.set("video_url", media.url);
  else createBody.set("image_url", media.url);

  // media_type: story = STORIES, video-feed = REELS, foto-feed = (geen)
  if (isStory) createBody.set("media_type", "STORIES");
  else if (isVideo) createBody.set("media_type", "REELS");

  // caption hoort niet bij stories
  if (!isStory) createBody.set("caption", caption);

  const createRes = await fetch(`${base}/${igId}/media`, {
    method: "POST",
    body: createBody,
  });
  const created = await createRes.json();
  if (!createRes.ok || !created.id) {
    throw new Error(created?.error?.message || "IG media-container mislukt");
  }

  // Video's worden asynchroon verwerkt → wachten tot de container klaar is.
  if (isVideo) await waitForContainer(base, created.id, token);

  const pubRes = await fetch(`${base}/${igId}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: created.id, access_token: token }),
  });
  const published = await pubRes.json();
  if (!pubRes.ok || !published.id) {
    throw new Error(published?.error?.message || "IG publiceren mislukt");
  }
  return { id: published.id };
}

/** Poll de container-status tot FINISHED. Max ~50s (Instagram-videoverwerking). */
async function waitForContainer(
  base: string,
  containerId: string,
  token: string,
): Promise<void> {
  for (let i = 0; i < 25; i++) {
    const res = await fetch(
      `${base}/${containerId}?fields=status_code,status&access_token=${token}`,
    );
    const data = await res.json();
    const code = data?.status_code;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(data?.status || "IG-videoverwerking mislukt");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("IG-videoverwerking duurde te lang");
}
