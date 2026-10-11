import { NextResponse } from "next/server";
import { duePosts, updateScheduled } from "@/lib/schedule";
import { publishForAccount } from "@/lib/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // video's kunnen even duren om te verwerken

/**
 * Verstuurt alle ingeplande posts waarvan de tijd verstreken is.
 * Wordt aangeroepen door Vercel Cron én mag door een externe pinger
 * (cron-job.org) elke minuut worden aangeroepen. Beschermd met CRON_SECRET.
 */
async function run(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const url = new URL(req.url);
    const provided =
      req.headers.get("authorization")?.replace("Bearer ", "") ||
      url.searchParams.get("secret");
    // Vercel Cron stuurt zelf een geldige Authorization-header mee
    const fromVercel = req.headers.get("authorization") === `Bearer ${secret}`;
    if (provided !== secret && !fromVercel) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
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
