"use client";

import { useEffect, useState, Suspense, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PLATFORM_MAP } from "@/lib/platforms";
import LogoutLink from "@/components/LogoutLink";

type HealthStatus = "ok" | "expiring" | "needs_reauth";

interface ChannelHealth {
  status: HealthStatus;
  expiresAt?: number;
  lastError?: string;
  connectedAt?: number;
}

interface AccountHealth {
  facebook?: ChannelHealth;
  instagram?: ChannelHealth;
  tiktok?: ChannelHealth;
  youtube?: ChannelHealth;
}

interface AccountState {
  id: string;
  name: string;
  facebook: boolean;
  instagram: boolean;
  pages: { id: string; name: string; instagram: string | null }[];
  selectedPageId: string | null;
  connectedAt: number | null;
  igLogin: { username: string } | null;
  tiktok: { displayName: string } | null;
  youtube: { channelTitle: string } | null;
  health?: AccountHealth;
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
  const [accounts, setAccounts] = useState<AccountState[]>([]);
  const [configured, setConfigured] = useState(true);
  const [newName, setNewName] = useState("");
  const [igConfigured, setIgConfigured] = useState(true);
  const [ttConfigured, setTtConfigured] = useState(false);
  const [ytConfigured, setYtConfigured] = useState(false);
  const metaResult = params.get("meta");
  const igResult = params.get("ig");
  const ttResult = params.get("tt");
  const ytResult = params.get("yt");
  const reden = params.get("reden");
  const activeAccount = params.get("account");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      setAccounts(data.accounts || []);
      setConfigured(data.configured);
      setIgConfigured(data.igConfigured);
      setTtConfigured(data.tiktokConfigured);
      setYtConfigured(data.youtubeConfigured);
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addAccount = async () => {
    await fetch("/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    setNewName("");
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

  const removeAccount = async (id: string) => {
    await fetch(`/api/accounts?id=${id}`, { method: "DELETE" });
    load();
  };

  const disconnect = async (id: string) => {
    await fetch(`/api/connections?account=${id}`, { method: "DELETE" });
    load();
  };

  const disconnectIg = async (id: string) => {
    await fetch(`/api/connections?account=${id}&type=ig`, { method: "DELETE" });
    load();
  };

  const disconnectType = async (id: string, type: string) => {
    await fetch(`/api/connections?account=${id}&type=${type}`, {
      method: "DELETE",
    });
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="SocialFlow" className="h-9 w-9 rounded-xl" />
            <div>
              <h1 className="text-base font-bold leading-none">SocialFlow</h1>
              <p className="text-[11px] text-muted">verbindingen</p>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <LogoutLink />
            <Link
              href="/planning"
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition hover:text-foreground"
            >
              🗓️ Planning
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition hover:text-foreground"
            >
              ← Terug naar composer
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 pb-24 pt-8">
        <h2 className="text-2xl font-bold">Accounts &amp; verbindingen</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Beheer meerdere accounts (bijv. per merk of klant). Elk account heeft
          z&apos;n eigen koppelingen met Facebook, Instagram en TikTok.
        </p>

        {metaResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ Koppeling gelukt! De accounts staan hieronder bijgewerkt.
          </div>
        )}
        {metaResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            ✕ Koppelen mislukt{reden ? `: ${reden}` : ""}. Controleer de
            redirect-URI en je rechten in de Meta-app.
          </div>
        )}
        {igResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ Instagram-login gelukt!
          </div>
        )}
        {igResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            ✕ Instagram-login mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}
        {ttResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ TikTok gekoppeld!
          </div>
        )}
        {ttResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            ✕ TikTok-koppeling mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}
        {ytResult === "ok" && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">
            ✓ YouTube gekoppeld!
          </div>
        )}
        {ytResult === "error" && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            ✕ YouTube-koppeling mislukt{reden ? `: ${reden}` : ""}.
          </div>
        )}

        {!configured && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            Meta-app niet geconfigureerd (META_APP_ID / META_APP_SECRET ontbreken).
          </div>
        )}

        {/* nieuw account toevoegen */}
        <div className="mt-6 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAccount()}
            placeholder="Naam nieuw account (bijv. 'Mijn merk' of 'Klant X')"
            className="flex-1 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-brand"
          />
          <button
            onClick={addAccount}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-black transition hover:brightness-110"
          >
            + Account
          </button>
        </div>

        {/* accounts */}
        <div className="mt-6 flex flex-col gap-5">
          {accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              configured={configured}
              igConfigured={igConfigured}
              ttConfigured={ttConfigured}
              ytConfigured={ytConfigured}
              highlight={a.id === activeAccount}
              onRename={(name) => rename(a.id, name)}
              onRemove={() => removeAccount(a.id)}
              onDisconnect={() => disconnect(a.id)}
              onDisconnectIg={() => disconnectIg(a.id)}
              onDisconnectType={(t) => disconnectType(a.id, t)}
              onSelectPage={(pageId) => selectPage(a.id, pageId)}
              canRemove={accounts.length > 1}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function AccountCard({
  account,
  configured,
  igConfigured,
  ttConfigured,
  ytConfigured,
  highlight,
  onRename,
  onRemove,
  onDisconnect,
  onDisconnectIg,
  onDisconnectType,
  onSelectPage,
  canRemove,
}: {
  account: AccountState;
  configured: boolean;
  igConfigured: boolean;
  ttConfigured: boolean;
  ytConfigured: boolean;
  highlight: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
  onDisconnect: () => void;
  onDisconnectIg: () => void;
  onDisconnectType: (type: string) => void;
  onSelectPage: (pageId: string) => void;
  canRemove: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const fb = PLATFORM_MAP.facebook;
  const ig = PLATFORM_MAP.instagram;
  const tt = PLATFORM_MAP.tiktok;
  // de pagina waarmee dit account daadwerkelijk post
  const activePage =
    account.pages.find((p) => p.id === account.selectedPageId) ??
    account.pages[0];

  return (
    <section
      className={`rounded-2xl border bg-surface p-5 transition ${
        highlight ? "border-brand" : "border-border"
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
            className="ml-auto text-xs text-muted transition hover:text-red-400"
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
                    value={activePage?.id ?? ""}
                    onChange={(e) => onSelectPage(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-2/50 px-2 py-1.5 text-[13px] outline-none focus:border-brand"
                  >
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
              {account.pages.length > 1 && activePage && (
                <p className="mt-1.5 text-[11px] text-accent">
                  {activePage.instagram
                    ? `✓ post naar ${activePage.name} + @${activePage.instagram}`
                    : `✓ post naar ${activePage.name} (geen Instagram gekoppeld)`}
                </p>
              )}
            </div>
          )}

          {account.facebook && <HealthLine health={account.health?.facebook} />}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {configured ? (
              <a
                href={`/api/auth/meta/login?account=${account.id}`}
                className="rounded-lg bg-gradient-to-r from-brand to-brand-2 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
              >
                {account.facebook ? "🔁 Opnieuw verbinden" : "🔗 Verbinden met Facebook"}
              </a>
            ) : (
              <span className="text-sm text-red-300">Meta niet geconfigureerd</span>
            )}
            {(account.facebook || account.instagram) && (
              <button
                onClick={onDisconnect}
                className="text-sm text-muted transition hover:text-red-400"
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
                className="rounded-lg bg-gradient-to-r from-[#f58529] via-[#dd2a7b] to-[#8134af] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
              >
                {account.igLogin
                  ? "🔁 Opnieuw inloggen"
                  : "🔗 Inloggen met Instagram"}
              </a>
            ) : (
              <span className="text-sm text-red-300">
                Instagram niet geconfigureerd
              </span>
            )}
            {account.igLogin && (
              <button
                onClick={onDisconnectIg}
                className="text-sm text-muted transition hover:text-red-400"
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
                Video&apos;s posten (testmodus: privé tot audit)
              </p>
            </div>
            <span className="ml-auto">
              <StatusPill ok={Boolean(account.tiktok)} label="TT" />
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
                className="rounded-lg bg-gradient-to-r from-[#25F4EE] to-[#FE2C55] px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110"
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
                className="text-sm text-muted transition hover:text-red-400"
              >
                Ontkoppelen
              </button>
            )}
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
                className="rounded-lg bg-gradient-to-r from-[#FF0000] to-[#7a0000] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
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
                className="text-sm text-muted transition hover:text-red-400"
              >
                Ontkoppelen
              </button>
            )}
          </div>
        </div>
      </div>

      {activePage === undefined && (
        <details className="mt-3 rounded-xl border border-border bg-surface-2/20 p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-muted">
            📋 Wat moet er eenmalig in de Meta-app staan?
          </summary>
          <ol className="mt-2 flex flex-col gap-1.5 pl-1 text-[13px]">
            {[
              "Facebook Login → Settings → Valid OAuth Redirect URIs: http://localhost:3000/api/auth/meta/callback",
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
    cls = "border border-red-500/40 bg-red-500/15 text-red-300";
    text = "✕ Opnieuw verbinden nodig";
  } else if (status === "expiring") {
    cls = "border border-orange-400/40 bg-orange-400/15 text-orange-300";
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
        <p className="text-[11px] text-red-300/90">Laatste fout: {lastError}</p>
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
