import { readMedia } from "@/lib/media";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const media = await readMedia(id);
  if (!media) {
    return new Response("Niet gevonden", { status: 404 });
  }
  return new Response(new Uint8Array(media.buffer), {
    headers: {
      "content-type": media.mime,
      "cache-control": "public, max-age=86400",
    },
  });
}
