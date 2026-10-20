import { NextResponse } from "next/server";
import {
  publishForAccount,
  resolveMediaInput,
  type MediaInput,
  type PublishTargets,
  type PublishCaptions,
} from "@/lib/publish";
import { requireAuth } from "@/lib/auth";
import { accountExists } from "@/lib/accounts";

export const runtime = "nodejs";
export const maxDuration = 300; // video's kunnen even duren (Hobby + Fluid Compute: max 300 s)

interface PublishBody {
  accountId?: unknown;
  /** Bij voorkeur { url, type } (directe upload); { dataUrl, type } blijft als fallback. */
  media?: MediaInput | null;
  targets?: unknown;
  captions?: unknown;
  dryRun?: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function bad(error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status: 400 });
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
  if (!isPlainObject(body)) return bad("Ongeldige aanvraag");
  if (typeof body.accountId !== "string" || !body.accountId) {
    return bad("Kies eerst een account");
  }
  if (!(await accountExists(body.accountId))) return bad("Onbekend account");
  if (!isPlainObject(body.targets)) return bad("Kies minstens één kanaal");
  if (body.captions !== undefined && body.captions !== null && !isPlainObject(body.captions)) {
    return bad("Ongeldige captions");
  }
  const dryRun = body.dryRun === true;

  let media: Awaited<ReturnType<typeof resolveMediaInput>>;
  try {
    media = await resolveMediaInput(body.media as MediaInput | null | undefined, dryRun);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Media opslaan mislukt" },
      { status: 400 },
    );
  }

  const out = await publishForAccount({
    accountId: body.accountId,
    mediaUrl: media?.url,
    mediaType: media?.type,
    targets: body.targets as PublishTargets,
    captions: (body.captions ?? {}) as PublishCaptions,
    dryRun,
  });

  if (out.error) return bad(out.error, { dropped: out.dropped, results: out.results });
  return NextResponse.json(out);
}
