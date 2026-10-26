import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireAuth } from "@/lib/auth";
import { accountExists } from "@/lib/accounts";
import { deleteDraft, getDraft, listDrafts, saveDraft, type Draft } from "@/lib/drafts";
import { isAllowedMediaUrl } from "@/lib/media";
import { parseCaptions } from "@/lib/post-view";
import { PLATFORMS, type PlatformId } from "@/lib/platforms";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** GET /api/drafts?accountId= (lijst) of ?id= (één concept). */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (id) {
    const d = await getDraft(id);
    return d ? NextResponse.json({ draft: d }) : bad("Concept niet gevonden", 404);
  }
  return NextResponse.json({ drafts: await listDrafts(params.get("accountId")) });
}

/** POST /api/drafts: concept opslaan (met id = bijwerken). */
export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad("Ongeldige aanvraag");
  }
  if (typeof body.accountId !== "string" || !(await accountExists(body.accountId))) {
    return bad("Onbekend account");
  }
  const media: Draft["media"] = [];
  for (const m of Array.isArray(body.media) ? body.media.slice(0, 10) : []) {
    if (!m || typeof m !== "object") return bad("Ongeldige media");
    const { url, type, name } = m as Record<string, unknown>;
    if (!isAllowedMediaUrl(url)) return bad("Ongeldige media-URL");
    media.push({
      url,
      type: type === "video" ? "video" : "image",
      ...(typeof name === "string" ? { name: name.slice(0, 200) } : {}),
    });
  }
  const channels = (Array.isArray(body.channels) ? body.channels : []).filter(
    (c): c is PlatformId => PLATFORMS.some((p) => p.id === c),
  );
  const now = Date.now();
  const id = typeof body.id === "string" && /^[a-f0-9-]{36}$/.test(body.id) ? body.id : randomUUID();
  const draft = await saveDraft({
    id,
    accountId: body.accountId,
    subject: typeof body.subject === "string" ? body.subject.slice(0, 500) : "",
    tone: typeof body.tone === "string" ? body.tone.slice(0, 40) : undefined,
    media,
    captions: parseCaptions(body.captions ?? {}) ?? {},
    channels,
    createdAt: now,
    updatedAt: now,
  });
  return NextResponse.json({ ok: true, draft });
}

/** DELETE /api/drafts?id= */
export async function DELETE(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id ontbreekt");
  await deleteDraft(id);
  return NextResponse.json({ ok: true });
}
