import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runDuePosts } from "@/lib/scheduler-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby + Fluid Compute staat 300 s toe (projectinstelling: default 300 s).
export const maxDuration = 300;

/**
 * Verstuurt ingeplande posts waarvan de tijd verstreken is.
 * Aangeroepen door QStash (precies op het geplande tijdstip), GitHub Actions
 * (elke 5 min, backup) en Vercel Cron (dagelijks).
 * Beschermd met CRON_SECRET via de header `Authorization: Bearer <CRON_SECRET>`.
 */
async function run(req: Request) {
  // Fail closed: zonder CRON_SECRET draait er niets.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET ontbreekt" }, { status: 503 });
  }
  const header = req.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runDuePosts());
}

export const GET = run;
export const POST = run;
