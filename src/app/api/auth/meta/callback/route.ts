import type { NextRequest } from "next/server";
import {
  exchangeCodeForToken,
  getLongLivedToken,
  fetchPages,
  missingMetaPermissions,
  saveMetaStore,
  loadMetaStore,
  checkMetaTokenHealth,
} from "@/lib/meta";
import {
  accountFromCallback,
  backToVerbindingen,
  INVALID_STATE_REASON,
} from "@/lib/oauth-state";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error =
    url.searchParams.get("error_description") || url.searchParams.get("error");

  // Eerst de state: zonder geldige (ondertekende + cookie) state geen enkele schrijfactie.
  const accountId = await accountFromCallback(req, "meta");
  if (!accountId) {
    return backToVerbindingen("meta", "error", { reden: INVALID_STATE_REASON });
  }
  const back = (status: string, reden?: string) =>
    backToVerbindingen("meta", status, { accountId, reden });

  if (error) return back("error", error);
  if (!code) return back("error", "geen_code");

  try {
    const shortToken = await exchangeCodeForToken(code);
    const long = await getLongLivedToken(shortToken);

    // Lees-only: zijn de rechten om te posten verleend?
    const missing = await missingMetaPermissions(long.token);
    if (missing?.length) {
      return back("error", `Toestemming geweigerd: ${missing.join(", ")}`);
    }

    const pages = await fetchPages(long.token);
    if (pages.length === 0) {
      return back("error", "Geen pagina's gedeeld: kies bij inloggen je pagina('s)");
    }

    // Behoud de eerder gekozen pagina als die er nog is; bij precies één
    // pagina is de keuze vanzelfsprekend.
    const prev = await loadMetaStore(accountId);
    const keep =
      prev?.selectedPageId && pages.some((p) => p.id === prev.selectedPageId)
        ? prev.selectedPageId
        : pages.length === 1
          ? pages[0].id
          : undefined;
    await saveMetaStore(accountId, {
      userToken: long.token,
      userTokenExpiresAt: long.expiresAt,
      pages,
      obtainedAt: Date.now(),
      selectedPageId: keep,
      explicitPageRequired: true,
      status: "ok",
    });
    // Lees-only debug_token: verloopdata van de gekozen pagina opslaan.
    if (keep) await checkMetaTokenHealth(accountId, { force: true }).catch(() => {});
    return back(keep ? "ok" : "kies_pagina");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende fout";
    return back("error", msg);
  }
}
