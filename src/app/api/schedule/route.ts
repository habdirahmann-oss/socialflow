import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { del } from "@vercel/blob";
import {
  listScheduled,
  getScheduled,
  addScheduled,
  removeScheduledPost,
  patchScheduled,
  type ScheduledPost,
  type ScheduledPatch,
} from "@/lib/schedule";
import { historyReferencesMedia } from "@/lib/history";
import { resolveMediaInput, type MediaInput } from "@/lib/publish";
import { normalizeTargets, countTargets } from "@/lib/targets";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";
import { postView, parseStatusFilter, parseCaptions } from "@/lib/post-view";

export const runtime = "nodejs";

interface ScheduleBody {
  id?: unknown;
  accountId?: unknown;
  accountName?: unknown;
  scheduledFor?: unknown;
  /** Bij voorkeur { url, type } (directe upload); { dataUrl, type } blijft als fallback. */
  media?: MediaInput | null;
  subject?: unknown;
  targets?: unknown;
  captions?: unknown;
  dryRun?: unknown;
}

const PLATFORMS = new Set(["facebook", "instagram", "tiktok", "youtube"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Geldige targets: object met bekende platformen → arrays van strings, minstens één plek. */
function parseTargets(t: unknown): ScheduledPost["targets"] | null {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    if (!PLATFORMS.has(k)) return null;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) {
      return null;
    }
    const uniq = [...new Set(v as string[])];
    if (uniq.length) out[k] = uniq;
    count += uniq.length;
  }
  return count > 0 ? (out as ScheduledPost["targets"]) : null;
}

/** GET /api/schedule?accountId=&status=pending,processing */
export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const accountId = params.get("accountId");
  const statuses = parseStatusFilter(params.get("status"));
  const posts = (await listScheduled())
    .filter((p) => !accountId || p.accountId === accountId)
    .filter((p) => !statuses || statuses.has(p.status))
    .sort((a, b) => a.scheduledFor - b.scheduledFor);
  return NextResponse.json({ posts: posts.map(postView) });
}

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: ScheduleBody;
  try {
    body = await req.json();
  } catch {
    return bad("Ongeldige aanvraag");
  }
  if (!body || typeof body !== "object") return bad("Ongeldige aanvraag");

  // Idempotentie: client-id dat al bestaat → bestaande post teruggeven.
  let id: string = randomUUID();
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !UUID_RE.test(body.id)) {
      return bad("Ongeldig id");
    }
    id = body.id.toLowerCase();
    const existing = await getScheduled(id);
    if (existing) {
      return NextResponse.json({ ok: true, id, existing: true, post: postView(existing) });
    }
  }

  const now = Date.now();
  const scheduledFor = body.scheduledFor;
  if (typeof scheduledFor !== "number" || !Number.isFinite(scheduledFor)) {
    return bad("Ongeldig tijdstip");
  }
  if (scheduledFor < now - 60_000) {
    return bad("Kies een tijdstip in de toekomst");
  }
  if (typeof body.accountId !== "string" || !(await accountExists(body.accountId))) {
    return bad("Onbekend account");
  }
  const targets = parseTargets(body.targets);
  if (!targets) return bad("Kies minstens één kanaal");
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return bad("Ongeldige testmodus-waarde");
  }
  const captions = parseCaptions(body.captions) ?? {};

  let media: Awaited<ReturnType<typeof resolveMediaInput>>;
  try {
    media = await resolveMediaInput(body.media, body.dryRun === true);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Media opslaan mislukt");
  }
  const mediaUrl = media?.url;

  // Alleen plaatsingen bewaren die met deze media echt kunnen.
  const norm = normalizeTargets(targets, media?.type);
  if (countTargets(norm.targets) === 0) {
    const why = norm.dropped
      .map((d) => `${d.platform} ${d.placement} (${d.reason})`)
      .join(", ");
    return bad(`Niets om in te plannen met deze media${why ? `: ${why}` : ""}`);
  }

  const post: ScheduledPost = {
    id,
    accountId: body.accountId,
    accountName:
      typeof body.accountName === "string" && body.accountName
        ? body.accountName
        : "account",
    scheduledFor,
    mediaUrl,
    mediaType: media?.type,
    // Alleen foto's krijgen een thumb; video's toont de lijst als <video>.
    thumb: media?.type === "image" && /^https?:/.test(media.url) ? media.url : undefined,
    subject:
      typeof body.subject === "string" && body.subject
        ? body.subject
        : "(zonder onderwerp)",
    targets: norm.targets,
    captions,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...(body.dryRun === true ? { dryRun: true } : {}),
  };
  try {
    const { post: saved, created } = await addScheduled(post);
    return NextResponse.json({
      ok: true,
      id: saved.id,
      ...(created ? {} : { existing: true }),
      ...(norm.dropped.length ? { dropped: norm.dropped } : {}),
      post: postView(saved),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Opslaan mislukt" },
      { status: 503 },
    );
  }
}

/** Tijdstip-validatie zoals bij inplannen: geldig getal, niet in het verleden. */
function checkScheduledFor(v: unknown, now: number): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return "Ongeldig tijdstip";
  if (v < now - 60_000) return "Kies een tijdstip in de toekomst";
  return null;
}

/**
 * PATCH /api/schedule?id=  {scheduledFor?, captions?, targets?}
 * Alleen zolang de post 'pending' is; bezig of afgerond → 409.
 */
export async function PATCH(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id ontbreekt");
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad("Ongeldige aanvraag");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("Ongeldige aanvraag");
  }

  const now = Date.now();
  const patch: ScheduledPatch = {};
  if (body.scheduledFor !== undefined) {
    const err = checkScheduledFor(body.scheduledFor, now);
    if (err) return bad(err);
    patch.scheduledFor = body.scheduledFor as number;
  }
  if (body.captions !== undefined) {
    const captions = parseCaptions(body.captions);
    if (!captions) return bad("Ongeldige captions");
    patch.captions = captions;
  }
  if (body.targets !== undefined) {
    const targets = parseTargets(body.targets);
    if (!targets) return bad("Kies minstens één kanaal");
    // Alleen plaatsingen die met de media van deze post kunnen.
    const current = await getScheduled(id);
    if (!current) return NextResponse.json({ error: "Post niet gevonden" }, { status: 404 });
    const kind = current.mediaUrl
      ? current.mediaType === "image"
        ? "image"
        : "video"
      : undefined;
    const norm = normalizeTargets(targets, kind);
    if (countTargets(norm.targets) === 0) {
      return bad("Niets om in te plannen met deze media");
    }
    patch.targets = norm.targets;
  }
  if (Object.keys(patch).length === 0) return bad("Niets om aan te passen");

  try {
    const res = await patchScheduled(id, patch, now);
    if (res.kind === "notfound") {
      return NextResponse.json({ error: "Post niet gevonden" }, { status: 404 });
    }
    if (res.kind === "conflict") {
      return NextResponse.json(
        {
          error:
            res.status === "processing"
              ? "Deze post wordt nu geplaatst en kan niet meer worden aangepast"
              : "Deze post is al afgerond en kan niet meer worden aangepast",
          status: res.status,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, post: postView(res.post) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Opslaan mislukt" },
      { status: 503 },
    );
  }
}

const isBlobUrl = (u: string) => {
  try {
    const url = new URL(u);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".public.blob.vercel-storage.com")
    );
  } catch {
    return false;
  }
};

/**
 * Ruimt het Blob-bestand van een verwijderde post op, maar alleen als geen
 * andere ingeplande post of geschiedenis-entry het nog gebruikt.
 * Fouten zijn niet fataal (het bestand blijft dan gewoon staan).
 */
async function cleanupMedia(mediaUrl: string | undefined): Promise<boolean> {
  if (!mediaUrl || !isBlobUrl(mediaUrl)) return false;
  try {
    const stillUsed =
      (await listScheduled()).some((p) => p.mediaUrl === mediaUrl) ||
      (await historyReferencesMedia(mediaUrl));
    if (stillUsed) return false;
    await del(mediaUrl);
    return true;
  } catch (e) {
    console.warn(
      "[schedule] media opruimen mislukt:",
      e instanceof Error ? e.message : "onbekend",
    );
    return false;
  }
}

export async function DELETE(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id ontbreekt");
  try {
    const { result, post } = await removeScheduledPost(id);
    if (result === "processing") {
      return NextResponse.json(
        { error: "Deze post wordt nu geplaatst" },
        { status: 409 },
      );
    }
    const mediaDeleted =
      result === "removed" ? await cleanupMedia(post?.mediaUrl) : false;
    return NextResponse.json({ ok: true, removed: result === "removed", mediaDeleted });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verwijderen mislukt" },
      { status: 503 },
    );
  }
}
