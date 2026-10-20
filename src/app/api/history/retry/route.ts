import { NextResponse } from "next/server";
import { retryHistory } from "@/lib/history";
import { requireAuth } from "@/lib/auth";
import { postView } from "@/lib/post-view";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/history/retry {id}
 * Claimt de entry onder lock (mag niet 'processing' zijn), publiceert alleen
 * de doelen zonder ok-resultaat en voegt de resultaten samen.
 */
export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige aanvraag" }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id ontbreekt" }, { status: 400 });

  try {
    const res = await retryHistory(id);
    if (res.kind === "notfound") {
      return NextResponse.json({ error: "Post niet gevonden" }, { status: 404 });
    }
    if (res.kind === "conflict") {
      return NextResponse.json({ error: res.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true, post: postView(res.entry) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Opnieuw proberen mislukt" },
      { status: 503 },
    );
  }
}
