import { NextResponse } from "next/server";
import {
  authEnabled,
  authMisconfigured,
  MISSING_PASSWORD_ERROR,
  checkPassword,
  sanitizeNext,
  sessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inloggen met het app-wachtwoord.
 * - JSON {password, next}  → 200 {ok, next} + cookie, of 401.
 * - Formulier (zonder JS)  → 303 redirect naar next, of terug naar /login.
 * Geen lockout; alleen een kleine vertraging bij een fout wachtwoord.
 */
export async function POST(req: Request) {
  const isJson = (req.headers.get("content-type") || "").includes("application/json");
  let password = "";
  let nextRaw: unknown = "/";

  if (isJson) {
    const body = await req.json().catch(() => ({}));
    password = typeof body?.password === "string" ? body.password : "";
    nextRaw = body?.next;
  } else {
    const form = await req.formData().catch(() => null);
    password = String(form?.get("password") ?? "");
    nextRaw = form?.get("next") ?? "/";
  }
  const next = sanitizeNext(nextRaw);

  // Wachtwoord verplicht maar niet ingesteld: niemand kan inloggen.
  if (authMisconfigured()) {
    if (isJson) {
      return NextResponse.json({ error: MISSING_PASSWORD_ERROR }, { status: 503 });
    }
    const back = new URL("/login", req.url);
    back.searchParams.set("fout", "config");
    back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  // Poort staat uit: niets te doen.
  if (!authEnabled()) {
    return isJson
      ? NextResponse.json({ ok: true, next })
      : NextResponse.redirect(new URL(next, req.url), 303);
  }

  if (!(await checkPassword(password))) {
    await new Promise((r) => setTimeout(r, 400));
    if (isJson) {
      return NextResponse.json({ error: "Onjuist wachtwoord" }, { status: 401 });
    }
    const back = new URL("/login", req.url);
    back.searchParams.set("fout", "1");
    back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  const res = isJson
    ? NextResponse.json({ ok: true, next })
    : NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: await sessionToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // niet 'strict': de OAuth-terugkeer moet de cookie houden
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
