import { NextResponse } from "next/server";
import {
  publishForAccount,
  resolveMediaUrl,
  type PublishTargets,
  type PublishCaptions,
} from "@/lib/publish";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300; // video's kunnen even duren (Hobby + Fluid Compute: max 300 s)

interface PublishBody {
  accountId: string;
  media?: { dataUrl: string; type: "image" | "video" } | null;
  targets: PublishTargets;
  captions: PublishCaptions;
  dryRun?: boolean;
}

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: PublishBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige aanvraag" }, { status: 400 });
  }

  let mediaUrl: string | undefined;
  if (body.media?.dataUrl) {
    try {
      mediaUrl = await resolveMediaUrl(body.media.dataUrl);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Media opslaan mislukt" },
        { status: 400 },
      );
    }
  }

  const out = await publishForAccount({
    accountId: body.accountId,
    mediaUrl,
    mediaType: body.media?.type,
    targets: body.targets,
    captions: body.captions,
    dryRun: body.dryRun,
  });

  if (out.error) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json(out);
}
