import { NextResponse } from "next/server";
import { authEnabled, authMisconfigured, isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Laat de UI weten of de wachtwoordpoort aan staat en of je ingelogd bent. */
export async function GET(req: Request) {
  return NextResponse.json({
    authEnabled: authEnabled(),
    authed: await isAuthed(req),
    misconfigured: authMisconfigured(),
  });
}
