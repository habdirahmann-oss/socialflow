import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  listScheduled,
  getScheduled,
  addScheduled,
  removeScheduled,
  type ScheduledPost,
} from "@/lib/schedule";
import { resolveMediaInput, type MediaInput } from "@/lib/publish";
import { accountExists } from "@/lib/accounts";
import { requireAuth } from "@/lib/auth";

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

/** Lichte versie voor de UI (geen captions/zware velden). */
function slim(p: ScheduledPost) {
  return {
    id: p.id,
    accountName: p.accountName,
    scheduledFor: p.scheduledFor,
    thumb: p.thumb,
    mediaType: p.mediaType,
    mediaUrl: p.mediaUrl,
    subject: p.subject,
    targets: p.targets,
    status: p.status,
    results: p.results,
    attempts: p.attempts,
    nextAttemptAt: p.nextAttemptAt,
    lastError: p.lastError,
    dryRun: p.dryRun,
    updatedAt: p.updatedAt,
  };
}

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

export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const posts = await listScheduled();
  return NextResponse.json({ posts: posts.map(slim) });
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
      return NextResponse.json({ ok: true, id, existing: true, post: slim(existing) });
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
  const captions =
    body.captions && typeof body.captions === "object" && !Array.isArray(body.captions)
      ? (body.captions as ScheduledPost["captions"])
      : {};

  let media: Awaited<ReturnType<typeof resolveMediaInput>>;
  try {
    media = await resolveMediaInput(body.media, body.dryRun === true);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Media opslaan mislukt");
  }
  const mediaUrl = media?.url;

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
    targets,
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
      post: slim(saved),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Opslaan mislukt" },
      { status: 503 },
    );
  }
}

export async function DELETE(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id ontbreekt");
  try {
    const res = await removeScheduled(id);
    if (res === "processing") {
      return NextResponse.json(
        { error: "Deze post wordt nu geplaatst" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, removed: res === "removed" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verwijderen mislukt" },
      { status: 503 },
    );
  }
}
