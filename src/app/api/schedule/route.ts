import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  listScheduled,
  addScheduled,
  removeScheduled,
  type ScheduledPost,
} from "@/lib/schedule";
import { resolveMediaUrl } from "@/lib/publish";
import { accountExists } from "@/lib/accounts";

export const runtime = "nodejs";

interface ScheduleBody {
  accountId: string;
  accountName?: string;
  scheduledFor: number;
  media?: { dataUrl: string; type: "image" | "video" } | null;
  subject?: string;
  targets: ScheduledPost["targets"];
  captions: ScheduledPost["captions"];
}

export async function GET() {
  const posts = await listScheduled();
  // stuur geen zware velden mee die de UI niet nodig heeft
  const slim = posts.map((p) => ({
    id: p.id,
    accountName: p.accountName,
    scheduledFor: p.scheduledFor,
    thumb: p.thumb,
    subject: p.subject,
    targets: p.targets,
    status: p.status,
    results: p.results,
  }));
  return NextResponse.json({ posts: slim });
}

export async function POST(req: Request) {
  let body: ScheduleBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige aanvraag" }, { status: 400 });
  }
  if (!body.accountId || !(await accountExists(body.accountId))) {
    return NextResponse.json({ error: "Onbekend account" }, { status: 400 });
  }
  if (!body.scheduledFor) {
    return NextResponse.json({ error: "Geen tijdstip" }, { status: 400 });
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

  const post: ScheduledPost = {
    id: randomUUID(),
    accountId: body.accountId,
    accountName: body.accountName || "account",
    scheduledFor: body.scheduledFor,
    mediaUrl,
    mediaType: body.media?.type,
    thumb: mediaUrl,
    subject: body.subject || "(zonder onderwerp)",
    targets: body.targets,
    captions: body.captions,
    status: "pending",
    createdAt: Date.now(),
  };
  await addScheduled(post);
  return NextResponse.json({ ok: true, id: post.id });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id ontbreekt" }, { status: 400 });
  await removeScheduled(id);
  return NextResponse.json({ ok: true });
}
