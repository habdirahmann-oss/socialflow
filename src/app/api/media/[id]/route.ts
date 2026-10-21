import { head } from "@vercel/blob";
import { readMedia, useBlob } from "@/lib/media";

export const runtime = "nodejs";

/** Alleen foto's uit onze eigen Blob-store (media/<uuid>.jpg|png) worden doorgegeven. */
const BLOB_ID_RE = /^[a-f0-9-]{36}\.(jpg|png)$/;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const media = await readMedia(id);
  if (media) {
    return new Response(new Uint8Array(media.buffer), {
      headers: {
        "content-type": media.mime,
        "cache-control": "public, max-age=86400",
      },
    });
  }
  // Op Vercel: foto uit Blob doorgeven via ons eigen (bij TikTok geverifieerde) domein.
  if (useBlob && BLOB_ID_RE.test(id)) {
    try {
      const meta = await head(`media/${id}`);
      const res = await fetch(meta.url);
      if (res.ok && res.body) {
        return new Response(res.body, {
          headers: {
            "content-type": meta.contentType || (id.endsWith(".png") ? "image/png" : "image/jpeg"),
            "cache-control": "public, max-age=86400",
          },
        });
      }
    } catch {
      // niet gevonden
    }
  }
  return new Response("Niet gevonden", { status: 404 });
}
