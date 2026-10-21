import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authEnabled, authMisconfigured, isAuthed, MISSING_PASSWORD_ERROR } from "@/lib/auth";

/**
 * Toegangspoort voor de hele app. Lokaal (`next dev`) zonder APP_PASSWORD doet
 * deze niets; op Vercel/productie zonder APP_PASSWORD faalt hij dicht (503).
 * Let op: de API-routes controleren de sessie zelf óók (requireAuth).
 */

const PUBLIC_EXACT = new Set([
  "/login",
  "/api/login",
  "/api/logout",
  "/api/session",
  "/privacy",
  "/voorwaarden",
  "/favicon.ico",
  "/icon.png",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (pathname.startsWith("/_next/")) return true;
  // OAuth-callbacks komen terug van Meta/Google/TikTok
  if (/^\/api\/auth\/[^/]+\/callback$/.test(pathname)) return true;
  // Cron heeft z'n eigen CRON_SECRET-check
  if (pathname.startsWith("/api/cron/")) return true;
  // Media moet publiek bereikbaar zijn voor Instagram/TikTok
  if (pathname.startsWith("/api/media/")) return true;
  // Statische bestanden uit public/ (logo.png, tiktok-verificatie.txt, ...)
  if (!pathname.startsWith("/api/")) {
    const last = pathname.split("/").pop() || "";
    if (/\.[A-Za-z0-9]+$/.test(last)) return true;
  }
  return false;
}

export async function proxy(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (authMisconfigured() && (pathname === "/api" || pathname.startsWith("/api/"))) {
    return NextResponse.json({ error: MISSING_PASSWORD_ERROR }, { status: 503 });
  }
  if (await isAuthed(request)) return NextResponse.next();

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Niet ingelogd" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // /api/upload staat bewust buiten de proxy: de proxy buffert request-bodies
  // (max 10 MB) en zou grote lokale uploads afkappen. De route checkt de
  // sessie zelf met requireAuth.
  matcher: ["/((?!_next/static|_next/image|api/upload).*)"],
};
