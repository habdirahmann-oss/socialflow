import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { duePosts, updateScheduled } from "@/lib/schedule";
import { publishForAccount } from "@/lib/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // video's kunnen even duren om te verwerken

/**
 * Verstuurt alle ingeplande posts waarvan de tijd verstreken is.
 * Wordt aangeroepen door Vercel Cron én mag door een externe pinger
 * (cron-job.org) elke minuut worden aangeroepen. Beschermd met CRON_SECRET
 * via de header `Authorization: Bearer <CRON_SECRET>`.
 */
async function run(req: Request) {
  // Fail closed: zonder CRON_SECRET draait er niets.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET ontbreekt" }, { status: 503 });
  }
  // Alleen de header 'Authorization: Bearer <secret>' (ook wat Vercel Cron stuurt).
  const header = req.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const due = await duePosts(now);
  const processed: { id: string; ok: boolean }[] = [];

  for (const post of due) {
    try {
      const out = await publishForAccount({
        accountId: post.accountId,
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
        targets: post.targets,
        captions: post.captions,
      });
      await updateScheduled(post.id, {
        status: out.ok ? "posted" : "failed",
        results: out.results,
      });
      processed.push({ id: post.id, ok: out.ok });
    } catch (e) {
      await updateScheduled(post.id, {
        status: "failed",
        results: [
          {
            platform: "-",
            placement: "-",
            ok: false,
            error: e instanceof Error ? e.message : "cron-fout",
          },
        ],
      });
      processed.push({ id: post.id, ok: false });
    }
  }

  return NextResponse.json({ ranAt: now, processed });
}

export const GET = run;
export const POST = run;
