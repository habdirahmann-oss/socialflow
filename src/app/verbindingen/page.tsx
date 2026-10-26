"use client";

import { useEffect, useState, Suspense, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { PLATFORM_MAP } from "@/lib/platforms";
import AppShell from "@/components/AppShell";
import type { AccountInfo, AccountsResponse, ChannelHealth } from "@/lib/types";

/** Vaste Nederlandse teksten voor bekende `reden`-waarden uit de callbacks. */
const REDEN_NL: Record<string, string> = {
  geen_account: "account niet gevonden — start het koppelen opnieuw vanaf deze pagina",
  geen_code: "geen autorisatiecode ontvangen — probeer het opnieuw",
  "Ongeldige of verlopen koppelpoging":
    "ongeldige of verlopen koppelpoging — start het koppelen opnieuw vanaf deze pagina en rond het binnen 10 minuten af",
  access_denied: "je hebt de toestemming geweigerd",
  user_denied: "je hebt de toestemming geweigerd",
  "Permissions error": "je hebt de toestemming geweigerd",
  "The user denied your request.": "je hebt de toestemming geweigerd",
  "Token-uitwisseling mislukt": "token-uitwisseling mislukt — probeer opnieuw te verbinden",
};

function redenText(reden: string | null): string | null {
  if (!reden) return null;
  return REDEN_NL[reden] ?? reden;
}

function postsText(n: number): string {
  return `${n} geplande ${n === 1 ? "post" : "posts"}`;
}

export default function VerbindingenPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const params = useSearchParams();
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [configured, setConfigured] = useState(true);
  const [newName, setNewName] = useState("");
  const [igConfigured, setIgConfigured] = useState(true);
  const [ttConfigured, setTtConfigured] = useState(false);
  const [ttbConfigured, setTtbConfigured] = useState(false);
  const [ytConfigured, setYtConfigured] = useState(false);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [maxAccounts, setMaxAccounts] = useState(10);
  const [addError, setAddError] = useState<string | null>(null);
  /** Net aangemaakt account: scrollen + oplichten. */
  const [newId, setNewId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const metaResult = params.get("meta");
  const igResult = params.get("ig");
  const ttResult = params.get("tt");
  const ttbResult = params.get("ttb");
  const ytResult = params.get("yt");
  const reden = redenText(params.get("reden"));
  const activeAccount = params.get("account");

  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let ignore = false;
    fetch("/api/accounts")
      .then((res) => res.json())
      .then((data: Partial<AccountsResponse> | null) => {
        if (ignore || !data || !Array.isArray(data.accounts)) return;
        setAccounts(data.accounts);
        setConfigured(Boolean(data.configured));
        setIgConfigured(Boolean(data.igConfigured));
        setTtConfigured(Boolean(data.tiktokConfigured));
        setTtbConfigured(Boolean(data.ttbConfigured));
        setYtConfigured(Boolean(data.youtubeConfigured));
        setAppUrl(typeof data.appUrl === "string" ? data.appUrl : null);
        if (typeof data.maxAccounts === "number") setMaxAccounts(data.maxAccounts);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  // Nieuw account in beeld scrollen zodra het in de lijst staat.
  useEffect(() => {
    if (!newId || !accounts.some((a) => a.id === newId)) return;
    document
      .getElementById(`account-${newId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [newId, accounts]);

  /** Per pagina-id: welke accounts posten ermee (voor de dubbel-waarschuwing). */
  const pageUsers = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of accounts) {
      if (!a.selectedPageId) continue;
      m.set(a.selectedPageId, [...(m.get(a.selectedPageId) || []), a.id]);
    }
    return m;
  }, [accounts]);

  const atMax = accounts.length >= maxAccounts;

  const addAccount = async () => {
    setAddError(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setAddError(data?.error || `Account aanmaken mislukt (HTTP ${res.status})`);
        return;
      }
      setNewName("");
      if (data?.id) setNewId(data.id);
    } catch {
      setAddError("Geen verbinding met de server");
    }
    load();
  };

  const rename = async (id: string, name: string) => {
    await fetch("/api/accounts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, name }),
    });
    load();
  };

  const removeAccount = async (a: AccountInfo) => {
    const n = a.pendingPosts || 0;
    const ok = window.confirm(
      `Account "${a.name}" verwijderen?\n\nAlle koppelingen van dit account worden ontkoppeld` +
        (n > 0
          ? ` en ${postsText(n)} ${n === 1 ? "wordt" : "worden"} geannuleerd.`
          : ". Er staan geen geplande posts klaar.") +
        "\n\nDit kan niet ongedaan worden gemaakt.",
    );
    if (!ok) return;
    await fetch(`/api/accounts?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
    load();
  };

  const CONNECTION_LABEL: Record<string, string> = {
    meta: "Facebook + Instagram (Meta)",
    ig: "Instagram (losse login)",
    tiktok: "TikTok",
    ttbiz: "TikTok Business (direct posten)",
    youtube: "YouTube",
  };

  /** Ontkoppel één koppeling (type = meta | ig | tiktok | youtube), na bevestiging. */
  const disconnectType = async (a: AccountInfo, type: string) => {
    const n = a.pendingPosts || 0;
    const label = CONNECTION_LABEL[type] ?? type;
    const ok = window.confirm(
      `${label} ontkoppelen van "${a.name}"?` +
        (n > 0
          ? `\n\nLet op: dit account heeft ${postsText(n)}. Die kunnen niet naar ${label} geplaatst worden zolang je niet opnieuw koppelt.`
          : "\n\nEr staan geen geplande posts klaar voor dit account."),
    );
    if (!ok) return;
    await fetch(
      `/api/connections?account=${encodeURIComponent(a.id)}&type=${encodeURIComponent(type)}`,
      { method: "DELETE" },
    );
    load();
  };

  const selectPage = async (id: string, pageId: string) => {
    await fetch("/api/connections", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: id, pageId }),
    });
    load();
  };

  return (
    <AppShell
      active="/verbindingen"
      title="Kanalen"
      subtitle={
        <>
          Beheer je accounts (per merk of klant, maximaal {maxAccounts}). Elk account heeft
          z&apos;n eigen koppelingen met Facebook, Instagram, TikTok en YouTube.
        </>
      }
    >
        {metaResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ Koppeling gelukt! De accounts staan hieronder bijgewerkt.
          </div>
        )}
        {metaResult === "kies_pagina" && (
          <div className="mt-5 rounded-xl border border-orange-400/40 bg-orange-400/10 px-4 py-3 text-sm text-orange-700">
            ⚠ Facebook is gekoppeld, maar je hebt toegang tot meerdere
            pagina&apos;s. Kies hieronder bij het account met welke pagina het
            post — tot die tijd wordt er niets naar Facebook/Instagram geplaatst.
          </div>
        )}
        {metaResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            ✕ Koppelen mislukt{reden ? `: ${reden}` : ""}. Controleer ook de
            redirect-URI en je rechten in de Meta-app.
          </div>
        )}
        {igResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ Instagram-login gelukt!
          </div>
        )}
        {igResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            ✕ Instagram-login mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}
        {ttResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ TikTok gekoppeld!
          </div>
        )}
        {ttResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            ✕ TikTok-koppeling mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}
        {ttbResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ TikTok Business gekoppeld: TikTok-posts gaan nu direct openbaar.
          </div>
        )}
        {ttbResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            ✕ TikTok Business-koppeling mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}
        {ytResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ YouTube gekoppeld!
          </div>
        )}
        {ytResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            ✕ YouTube-koppeling mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}

        {!configured && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            Meta-app niet geconfigureerd (META_APP_ID / META_APP_SECRET ontbreken).
          </div>
        )}

        {/* nieuw account toevoegen */}
        <div className="mt-6 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !atMax && addAccount()}
            placeholder="Naam nieuw account (bijv. 'Mijn merk' of 'Klant X')"
            disabled={atMax}
            className="flex-1 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-brand disabled:opacity-50"
          />
          <button
            onClick={addAccount}
            disabled={atMax}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Account
          </button>
        </div>
        {(addError || atMax) && (
          <p className={`mt-2 text-xs ${addError ? "text-red-600" : "text-muted"}`}>
            {addError ?? `Maximaal ${maxAccounts} klantaccounts bereikt.`}
          </p>
        )}

        {/* accounts */}
        <div className="mt-6 flex flex-col gap-5">
          {accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              configured={configured}
              igConfigured={igConfigured}
              ttConfigured={ttConfigured}
              ttbConfigured={ttbConfigured}
              ytConfigured={ytConfigured}
              redirectUri={`${appUrl ?? (typeof window !== "undefined" ? window.location.origin : "")}/api/auth/meta/callback`}
              highlight={a.id === activeAccount || a.id === newId}
              samePageAccounts={(a.selectedPageId ? pageUsers.get(a.selectedPageId) ?? [] : [])
                .filter((id) => id !== a.id)
                .map((id) => accounts.find((x) => x.id === id)?.name ?? "ander account")}
              onRename={(name) => rename(a.id, name)}
              onRemove={() => removeAccount(a)}
              onDisconnectType={(t) => disconnectType(a, t)}
              onSelectPage={(pageId) => selectPage(a.id, pageId)}
              canRemove={accounts.length > 1}
            />
          ))}
        </div>
    </AppShell>
  );
}

function AccountCard({
  account,
  configured,
  igConfigured,
  ttConfigured,
  ttbConfigured,
  ytConfigured,
  redirectUri,
  highlight,
  samePageAccounts,
  onRename,
  onRemove,
  onDisconnectType,
  onSelectPage,
  canRemove,
}: {
  account: AccountInfo;
  configured: boolean;
  igConfigured: boolean;
  ttConfigured: boolean;
  ttbConfigured: boolean;
  ytConfigured: boolean;
  redirectUri: string;
  highlight: boolean;
  /** Namen van andere accounts die met dezelfde Facebook-pagina posten. */
  samePageAccounts: string[];
  onRename: (name: string) => void;
  onRemove: () => void;
  onDisconnectType: (type: string) => void;
  onSelectPage: (pageId: string) => void;
  canRemove: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const fb = PLATFORM_MAP.facebook;
  const ig = PLATFORM_MAP.instagram;
  const tt = PLATFORM_MAP.tiktok;
  // de pagina waarmee dit account daadwerkelijk post (server bepaalt dit)
  const activePage = account.pages.find((p) => p.id === account.selectedPageId);
  // Expliciete keuze nodig (nieuwe koppeling) of aan te raden (oude koppeling)?
  const needsChoice = Boolean(account.pageChoiceRequired || account.implicitPage);

  return (
    <section
      id={`account-${account.id}`}
      className={`scroll-mt-24 rounded-2xl border bg-surface p-5 transition ${
        highlight ? "border-brand ring-2 ring-brand/40" : "border-border"
      }`}
    >
      {/* account header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-sm">
          👤
        </div>
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name !== account.name) onRename(name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditing(false);
                if (name !== account.name) onRename(name);
              }
            }}
            className="rounded-lg border border-border bg-surface-2/50 px-2 py-1 text-base font-semibold outline-none focus:border-brand"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-base font-semibold hover:text-brand"
            title="Klik om te hernoemen"
          >
            {account.name} <span className="text-xs text-muted">✎</span>
          </button>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            className="ml-auto text-xs text-muted transition hover:text-red-600"
          >
            Account verwijderen
          </button>
        )}
      </div>

      {/* kanalen binnen dit account */}
      <div className="mt-4 flex flex-col gap-3">
        {/* Facebook + Instagram (samen via Meta) */}
        <div className="rounded-xl border border-border bg-surface-2/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1.5">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
                style={{ background: fb.gradient }}
              >
                f
              </span>
              <span
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
                style={{ background: ig.gradient }}
              >
                IG
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold">Facebook + Instagram</p>
              <p className="text-[11px] text-muted">Eén Meta-koppeling</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <StatusPill ok={account.facebook} label="FB" />
              <StatusPill ok={account.instagram} label="IG" />
            </div>
          </div>

          {account.facebook && (
            <div className="mt-3 rounded-lg border border-border bg-background/40 p-2.5 text-[13px]">
              {account.pages.length > 1 ? (
                <>
                  <label className="mb-1 block text-[11px] text-muted">
                    Posten vanaf deze pagina
                  </label>
                  <select
                    value={needsChoice ? "" : (activePage?.id ?? "")}
                    onChange={(e) => e.target.value && onSelectPage(e.target.value)}
                    className={`w-full rounded-lg border bg-surface-2/50 px-2 py-1.5 text-[13px] outline-none focus:border-brand ${
                      needsChoice ? "border-orange-400/60" : "border-border"
                    }`}
                  >
                    <option value="" disabled>
                      Kies pagina…
                    </option>
                    {account.pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.instagram ? ` · @${p.instagram}` : " · geen Instagram"}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[11px] text-muted">
                    Je hebt toegang tot {account.pages.length} pagina&apos;s —
                    kies welke bij dit account hoort.
                  </p>
                </>
              ) : (
                <>
                  {activePage && (
                    <p>
                      📘 <strong>{activePage.name}</strong>
                    </p>
                  )}
                  {activePage?.instagram && (
                    <p className="mt-0.5">
                      📸 <strong>@{activePage.instagram}</strong>
                    </p>
                  )}
                </>
              )}
              {account.pageChoiceRequired && (
                <p className="mt-1.5 rounded-md bg-orange-400/15 px-2 py-1 text-[11px] font-medium text-orange-700">
                  ⚠ Kies een pagina — tot die tijd wordt er niets naar Facebook
                  of Instagram (via de pagina) geplaatst.
                </p>
              )}
              {account.implicitPage && activePage && (
                <p className="mt-1.5 rounded-md bg-orange-400/15 px-2 py-1 text-[11px] font-medium text-orange-700">
                  ⚠ Kies expliciet een pagina — nu wordt automatisch de eerste
                  gebruikt ({activePage.name}).
                </p>
              )}
              {account.pages.length > 1 && activePage && !account.implicitPage && (
                <p className="mt-1.5 text-[11px] text-accent">
                  {activePage.instagram
                    ? `✓ post naar ${activePage.name} + @${activePage.instagram}`
                    : `✓ post naar ${activePage.name} (geen Instagram gekoppeld)`}
                </p>
              )}
              {activePage && samePageAccounts.length > 0 && (
                <p className="mt-1.5 rounded-md bg-orange-400/15 px-2 py-1 text-[11px] font-medium text-orange-700">
                  ⚠ Let op: {activePage.name} is ook gekozen bij{" "}
                  {samePageAccounts.join(", ")}. Posts van beide accounts komen
                  op dezelfde pagina.
                </p>
              )}
            </div>
          )}

          {account.igPublishVia && (
            <p className="mt-2 text-[11px] text-muted">
              Instagram post via:{" "}
              <strong className="text-foreground/90">@{account.igPublishVia.username}</strong>{" "}
              {account.igPublishVia.route === "login" ? "(losse login)" : "(via Facebook-pagina)"}
            </p>
          )}

          {account.facebook && <HealthLine health={account.health?.facebook} />}

          {configured && (
            <p className="mt-3 text-[11px] text-orange-700">
              💡 Laat bij inloggen ALLE klantpagina&apos;s aangevinkt — anders
              verdwijnen pagina&apos;s bij andere accounts.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {configured ? (
              <a
                href={`/api/auth/meta/login?account=${account.id}`}
                className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-surface-2"
              >
                {account.facebook ? "🔁 Opnieuw verbinden" : "🔗 Verbinden met Facebook"}
              </a>
            ) : (
              <span className="text-sm text-red-600">Meta niet geconfigureerd</span>
            )}
            {(account.facebook || account.instagram) && (
              <button
                onClick={() => onDisconnectType("meta")}
                className="text-sm text-muted transition hover:text-red-600"
              >
                Ontkoppelen
              </button>
            )}
          </div>
        </div>

        {/* Instagram los (Instagram Login, zonder Facebook) */}
        <div className="rounded-xl border border-border bg-surface-2/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ background: ig.gradient }}
            >
              IG
            </span>
            <div>
              <p className="text-sm font-semibold">Instagram (los inloggen)</p>
              <p className="text-[11px] text-muted">
                Direct via Instagram, zonder Facebook-pagina
              </p>
            </div>
            <span className="ml-auto">
              <StatusPill ok={Boolean(account.igLogin)} label="IG" />
            </span>
          </div>

          {account.igLogin && (
            <div className="mt-3 rounded-lg border border-border bg-background/40 p-2.5 text-[13px]">
              📸 <strong>@{account.igLogin.username}</strong>
            </div>
          )}
          {account.igLogin && <HealthLine health={account.health?.instagram} />}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {igConfigured ? (
              <a
                href={`/api/auth/instagram/login?account=${account.id}`}
                className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-surface-2"
              >
                {account.igLogin
                  ? "🔁 Opnieuw inloggen"
                  : "🔗 Inloggen met Instagram"}
              </a>
            ) : (
              <span className="text-sm text-red-600">
                Instagram niet geconfigureerd
              </span>
            )}
            {account.igLogin && (
              <button
                onClick={() => onDisconnectType("ig")}
                className="text-sm text-muted transition hover:text-red-600"
              >
                Ontkoppelen
              </button>
            )}
          </div>
        </div>

        {/* TikTok */}
        <div className="rounded-xl border border-border bg-surface-2/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ background: tt.gradient }}
            >
              TT
            </span>
            <div>
              <p className="text-sm font-semibold">TikTok</p>
              <p className="text-[11px] text-muted">
                Video&apos;s en foto&apos;s posten
              </p>
            </div>
            <span className="ml-auto">
              <StatusPill ok={Boolean(account.tiktok || account.tiktokBusiness)} label="TT" />
            </span>
          </div>
          {account.tiktok && (
            <div className="mt-3 rounded-lg border border-border bg-background/40 p-2.5 text-[13px]">
              🎵 <strong>{account.tiktok.displayName}</strong>
            </div>
          )}
          {account.tiktok && <HealthLine health={account.health?.tiktok} />}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {ttConfigured ? (
              <a
                href={`/api/auth/tiktok/login?account=${account.id}`}
                className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-surface-2"
              >
                {account.tiktok ? "🔁 Opnieuw koppelen" : "🔗 Koppel TikTok"}
              </a>
            ) : (
              <span className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted">
                🔒 Wacht op TikTok developer-app
              </span>
            )}
            {account.tiktok && (
              <button
                onClick={() => onDisconnectType("tiktok")}
                className="text-sm text-muted transition hover:text-red-600"
              >
                Ontkoppelen
              </button>
            )}
          </div>

          {/* Direct openbaar posten via de TikTok API for Business */}
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs font-medium">
              Direct openbaar posten{" "}
              <span className="font-normal text-muted">(TikTok Business-account)</span>
            </p>
            {account.tiktokBusiness ? (
              <p className="mt-1 text-xs text-accent">
                ✓ Actief via <strong>{account.tiktokBusiness.displayName}</strong>: TikTok-posts
                gaan direct live.
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">
                Zonder deze koppeling komen TikTok-posts als concept in je TikTok-inbox.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {ttbConfigured ? (
                <a
                  href={`/api/auth/ttbiz/login?account=${account.id}`}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-2"
                >
                  {account.tiktokBusiness ? "Opnieuw koppelen" : "Koppel voor direct posten"}
                </a>
              ) : (
                <span className="text-[11px] text-muted">
                  Nog niet beschikbaar: wacht op goedkeuring van TikTok for Business.
                </span>
              )}
              {account.tiktokBusiness && (
                <button
                  onClick={() => onDisconnectType("ttbiz")}
                  className="text-xs text-muted transition hover:text-red-600"
                >
                  Ontkoppelen
                </button>
              )}
            </div>
          </div>
        </div>

        {/* YouTube */}
        <div className="rounded-xl border border-border bg-surface-2/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ background: PLATFORM_MAP.youtube.gradient }}
            >
              YT
            </span>
            <div>
              <p className="text-sm font-semibold">YouTube</p>
              <p className="text-[11px] text-muted">Shorts &amp; video&apos;s uploaden</p>
            </div>
            <span className="ml-auto">
              <StatusPill ok={Boolean(account.youtube)} label="YT" />
            </span>
          </div>
          {account.youtube && (
            <div className="mt-3 rounded-lg border border-border bg-background/40 p-2.5 text-[13px]">
              ▶️ <strong>{account.youtube.channelTitle}</strong>
            </div>
          )}
          {account.youtube && <HealthLine health={account.health?.youtube} />}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {ytConfigured ? (
              <a
                href={`/api/auth/youtube/login?account=${account.id}`}
                className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-surface-2"
              >
                {account.youtube ? "🔁 Opnieuw koppelen" : "🔗 Koppel YouTube"}
              </a>
            ) : (
              <span className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted">
                🔒 Wacht op Google Cloud-app
              </span>
            )}
            {account.youtube && (
              <button
                onClick={() => onDisconnectType("youtube")}
                className="text-sm text-muted transition hover:text-red-600"
              >
                Ontkoppelen
              </button>
            )}
          </div>
        </div>
      </div>

      {account.pages.length === 0 && (
        <details className="mt-3 rounded-xl border border-border bg-surface-2/20 p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-muted">
            📋 Wat moet er eenmalig in de Meta-app staan?
          </summary>
          <ol className="mt-2 flex flex-col gap-1.5 pl-1 text-[13px]">
            {[
              `Facebook Login → Settings → Valid OAuth Redirect URIs: ${redirectUri}`,
              "Instagram = Business/Creator-account, gekoppeld aan je Facebook-pagina",
              "App in 'Development' mode en jij bent admin (geen review nodig voor eigen accounts)",
            ].map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-foreground/90">
                <span className="text-muted">{i + 1}.</span>
                {s}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

const DAY_MS = 86_400_000;

function daysLeft(ts: number): number {
  return Math.max(0, Math.ceil((ts - Date.now()) / DAY_MS));
}

function dagen(n: number): string {
  if (n === 0) return "vandaag";
  return `over ${n} ${n === 1 ? "dag" : "dagen"}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("nl-NL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Token-gezondheid van één koppeling: groen (OK), oranje (verloopt binnen
 * 10 dagen) of rood (opnieuw verbinden nodig, met de laatste fout).
 * De bestaande 'Opnieuw verbinden'-knop staat er direct onder.
 */
function HealthLine({ health }: { health?: ChannelHealth }) {
  if (!health) return null;
  const { status, expiresAt, lastError, connectedAt } = health;
  let cls: string;
  let text: string;
  if (status === "needs_reauth") {
    cls = "border border-red-500/40 bg-red-500/15 text-red-600";
    text = "✕ Opnieuw verbinden nodig";
  } else if (status === "expiring") {
    cls = "border border-orange-400/40 bg-orange-400/15 text-orange-700";
    text = expiresAt ? `⚠ Verloopt ${dagen(daysLeft(expiresAt))}` : "⚠ Verloopt binnenkort";
  } else {
    cls = "bg-accent/15 text-accent";
    text = expiresAt
      ? `✓ OK · verloopt ${dagen(daysLeft(expiresAt))}`
      : "✓ OK · verloopt niet";
  }
  return (
    <div className="mt-3 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}
          title={expiresAt ? `Verloopt op ${formatDate(expiresAt)}` : undefined}
        >
          {text}
        </span>
        {connectedAt ? (
          <span className="text-[11px] text-muted">
            gekoppeld op {formatDate(connectedAt)}
          </span>
        ) : null}
      </div>
      {status === "needs_reauth" && lastError && (
        <p className="text-[11px] text-red-600">Laatste fout: {lastError}</p>
      )}
    </div>
  );
}

function StatusPill({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[11px] ${
        ok ? "bg-accent/15 text-accent" : "border border-border text-muted"
      }`}
    >
      {ok ? "✓" : "○"} {label}
    </span>
  );
}
