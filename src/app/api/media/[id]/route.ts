import { head } from "@vercel/blob";
import { readMedia, useBlob } from "@/lib/media";

export const runtime = "nodejs";

/** Alleen media uit onze eigen Blob-store (media/<uuid>.<ext>) wordt doorgegeven. */
const BLOB_ID_RE = /^[a-f0-9-]{36}\.(jpg|png|mp4|mov)$/;
const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

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
            "content-type": meta.contentType || MIME[id.split(".").pop() || ""] || "application/octet-stream",
            ...(res.headers.get("content-length")
              ? { "content-length": res.headers.get("content-length")! }
              : {}),
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
