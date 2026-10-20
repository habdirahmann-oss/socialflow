import { NextResponse } from "next/server";
import {
  prepareScheduledAction,
  processPost,
  getScheduled,
} from "@/lib/schedule";
import { requireAuth } from "@/lib/auth";
import { postView } from "@/lib/post-view";

export const runtime = "nodejs";
// Publiceert direct (video's kunnen even duren).
export const maxDuration = 300;

const STATUS_NL: Record<string, string> = {
  pending: "gepland",
  processing: "bezig",
  posted: "gepost",
  partial: "gedeeltelijk gepost",
  failed: "mislukt",
};

/**
 * POST /api/schedule/action {id, action: 'post-now' | 'retry'}
 * - post-now (pending): tijdstip = nu, daarna direct processPost.
 * - retry (failed/partial): pogingen = 0, weer pending, daarna processPost.
 * processPost verstuurt alleen de doelen zonder ok-resultaat.
 */
export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: { id?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige aanvraag" }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id : "";
  const action = body?.action;
  if (!id) return NextResponse.json({ error: "id ontbreekt" }, { status: 400 });
  if (action !== "post-now" && action !== "retry") {
    return NextResponse.json({ error: "Onbekende actie" }, { status: 400 });
  }

  try {
    const now = Date.now();
    const prep = await prepareScheduledAction(id, action, now);
    if (prep.kind === "notfound") {
      return NextResponse.json({ error: "Post niet gevonden" }, { status: 404 });
    }
    if (prep.kind === "conflict") {
      return NextResponse.json(
        {
          error:
            action === "post-now"
              ? `Alleen geplande posts kunnen nu gepost worden (status: ${STATUS_NL[prep.status] ?? prep.status})`
              : `Alleen mislukte of gedeeltelijke posts kunnen opnieuw (status: ${STATUS_NL[prep.status] ?? prep.status})`,
          status: prep.status,
        },
        { status: 409 },
      );
    }
    // Kan null zijn als de cron hem net heeft opgepakt; dan tonen we de huidige stand.
    const done = await processPost(id, Date.now());
    const post = done ?? (await getScheduled(id));
    return NextResponse.json({
      ok: true,
      processed: Boolean(done),
      post: post ? postView(post) : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Actie mislukt" },
      { status: 503 },
    );
  }
}
