"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import PlatformBadge from "@/components/PlatformBadge";
import { postJson } from "@/lib/client-fetch";
import type { PostView } from "@/lib/post-view";
import type { AccountInfo, AccountsResponse, HealthStatus } from "@/lib/types";
import {
  CHANNEL_ORDER,
  LS_ACCOUNT_KEY,
  channelHandle,
  formatWhen,
  healthWarnings,
  isConnected,
  platformName,
} from "../_components/composer-lib";

const DOT: Record<HealthStatus | "off", string> = {
  ok: "bg-accent",
  expiring: "bg-amber-500",
  needs_reauth: "bg-red-500",
  off: "bg-border",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Vaste, rustige kleur per klant (op basis van het id). */
function avatarHue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function remember(id: string) {
  try {
    localStorage.setItem(LS_ACCOUNT_KEY, id);
  } catch {
    /* geen opslag: niet erg */
  }
}

/**
 * Bureau-overzicht: alle klanten in één scherm, met per klant de gekoppelde
 * kanalen, wat er gepland staat en wat aandacht nodig heeft.
 */
export default function KlantenPage() {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [pending, setPending] = useState<PostView[]>([]);
  const [recent, setRecent] = useState<PostView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      postJson<AccountsResponse>("/api/accounts", undefined, "GET"),
      postJson<{ posts?: PostView[] }>("/api/schedule?status=pending,processing", undefined, "GET"),
      postJson<{ entries?: PostView[] }>("/api/history", undefined, "GET").catch(() => ({
        entries: [] as PostView[],
      })),
    ])
      .then(([acc, sched, hist]) => {
        if (!alive) return;
        setData(acc);
        setPending(sched.posts || []);
        setRecent(hist.entries || []);
        setNow(Date.now());
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Laden mislukt");
      });
    return () => {
      alive = false;
    };
  }, []);

  const accounts = useMemo(() => data?.accounts ?? [], [data]);

  const perAccount = useMemo(() => {
    const map = new Map<string, { next?: PostView; count: number; last?: PostView }>();
    for (const p of pending) {
      const cur = map.get(p.accountId) ?? { count: 0 };
      cur.count += 1;
      if (!cur.next || p.scheduledFor < cur.next.scheduledFor) cur.next = p;
      map.set(p.accountId, cur);
    }
    for (const p of recent) {
      const cur = map.get(p.accountId) ?? { count: 0 };
      // history komt nieuwste eerst binnen
      if (!cur.last) cur.last = p;
      map.set(p.accountId, cur);
    }
    return map;
  }, [pending, recent]);

  const attention = useMemo(
    () =>
      accounts.filter(
        (a) =>
          healthWarnings(a, now).length > 0 ||
          a.pageChoiceRequired ||
          !CHANNEL_ORDER.some((pid) => isConnected(a, pid)),
      ).length,
    [accounts, now],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? accounts.filter((a) => a.name.toLowerCase().includes(q)) : accounts;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, "nl"));
  }, [accounts, query]);

  const max = data?.maxAccounts ?? 50;
  const atMax = accounts.length >= max;

  const addClient = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const created = await postJson<{ id: string }>("/api/accounts", { name: newName.trim() });
      remember(created.id);
      // meteen door naar Kanalen om de socials van de nieuwe klant te koppelen
      window.location.href = `/verbindingen?account=${encodeURIComponent(created.id)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Klant toevoegen mislukt");
      setBusy(false);
    }
  };

  const connectedTotal = accounts.reduce(
    (n, a) => n + CHANNEL_ORDER.filter((pid) => isConnected(a, pid)).length,
    0,
  );

  return (
    <AppShell
      active="/klanten"
      title="Klanten"
      subtitle="Al je klanten in één overzicht. Kies een klant om te posten, te plannen of kanalen te koppelen."
      wide
      actions={
        <button
          type="button"
          disabled={atMax}
          onClick={() => setAdding(true)}
          className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
          title={atMax ? `Maximaal ${max} klanten` : undefined}
        >
          + Klant toevoegen
        </button>
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {adding && (
        <form
          className="card mb-5 flex flex-wrap items-center gap-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void addClient();
          }}
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Naam van de klant of het merk"
            maxLength={80}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!newName.trim() || busy}
            className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Bezig…" : "Toevoegen en kanalen koppelen"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setNewName("");
            }}
            className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2"
          >
            Annuleren
          </button>
        </form>
      )}

      {/* kerncijfers */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Klanten" value={data ? `${accounts.length}` : "…"} hint={`max. ${max}`} />
        <Stat label="Kanalen gekoppeld" value={data ? `${connectedTotal}` : "…"} />
        <Stat label="Gepland" value={data ? `${pending.length}` : "…"} hint="posts" />
        <Stat
          label="Aandacht nodig"
          value={data ? `${attention}` : "…"}
          tone={attention > 0 ? "warn" : undefined}
        />
      </div>

      {accounts.length > 6 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Zoek een klant…"
          className="mb-4 w-full max-w-sm rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />
      )}

      {!data && !error && <p className="text-sm text-muted">Klanten laden…</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((a) => (
          <ClientCard key={a.id} account={a} info={perAccount.get(a.id)} now={now} />
        ))}
      </div>

      {data && shown.length === 0 && (
        <p className="text-sm text-muted">Geen klant gevonden voor &lsquo;{query}&rsquo;.</p>
      )}
    </AppShell>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === "warn" ? "text-amber-600" : ""}`}>
        {value}
        {hint && <span className="ml-1.5 text-xs font-normal text-muted">{hint}</span>}
      </p>
    </div>
  );
}

function ClientCard({
  account: a,
  info,
  now,
}: {
  account: AccountInfo;
  info?: { next?: PostView; count: number; last?: PostView };
  now: number;
}) {
  const warnings = healthWarnings(a, now);
  const connected = CHANNEL_ORDER.filter((pid) => isConnected(a, pid));
  const id = encodeURIComponent(a.id);
  const hue = avatarHue(a.id);

  return (
    <div className="card flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold"
          style={{ background: `hsl(${hue} 70% 94%)`, color: `hsl(${hue} 55% 35%)` }}
        >
          {initials(a.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{a.name}</p>
          <p className="text-xs text-muted">
            {connected.length === 0
              ? "Nog geen kanalen gekoppeld"
              : `${connected.length} van ${CHANNEL_ORDER.length} kanalen gekoppeld`}
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {CHANNEL_ORDER.map((pid) => {
          const on = isConnected(a, pid);
          const status: HealthStatus | "off" = on ? (a.health?.[pid]?.status ?? "ok") : "off";
          const handle = on ? channelHandle(a, pid) : null;
          return (
            <li key={pid} className="flex items-center gap-2 text-xs">
              <span className={on ? "" : "opacity-35 grayscale"}>
                <PlatformBadge id={pid} />
              </span>
              <span className={`min-w-0 flex-1 truncate ${on ? "" : "text-muted"}`}>
                {handle || (on ? platformName(pid) : "niet gekoppeld")}
              </span>
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[status]}`} />
            </li>
          );
        })}
      </ul>

      {(warnings.length > 0 || a.pageChoiceRequired) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
          {a.pageChoiceRequired && <p>Facebook: kies welke pagina bij deze klant hoort</p>}
          {warnings.map((w) => (
            <p key={w.platform + w.text}>{w.text}</p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs">
        <p>
          <span className="text-muted">Volgende post: </span>
          {info?.next ? (
            <span className="font-medium">{formatWhen(info.next.scheduledFor)}</span>
          ) : (
            <span className="text-muted">niets gepland</span>
          )}
          {info && info.count > 1 && <span className="text-muted"> (+{info.count - 1} meer)</span>}
        </p>
        <p className="truncate">
          <span className="text-muted">Laatste post: </span>
          {info?.last ? (
            <span title={info.last.subject}>
              {new Date(info.last.createdAt ?? info.last.scheduledFor).toLocaleDateString("nl-NL", {
                day: "numeric",
                month: "short",
              })}
              {info.last.subject ? `, ${info.last.subject}` : ""}
            </span>
          ) : (
            <span className="text-muted">nog niets</span>
          )}
        </p>
      </div>

      <div className="mt-auto grid grid-cols-3 gap-2">
        <Link
          href={`/?account=${id}`}
          onClick={() => remember(a.id)}
          className="rounded-lg bg-brand px-2 py-2 text-center text-xs font-semibold text-white hover:opacity-90"
        >
          Nieuwe post
        </Link>
        <Link
          href={`/planning?account=${id}`}
          onClick={() => remember(a.id)}
          className="rounded-lg border border-border px-2 py-2 text-center text-xs font-medium hover:bg-surface-2"
        >
          Planning
        </Link>
        <Link
          href={`/verbindingen?account=${id}`}
          onClick={() => remember(a.id)}
          className="rounded-lg border border-border px-2 py-2 text-center text-xs font-medium hover:bg-surface-2"
        >
          Kanalen
        </Link>
      </div>
    </div>
  );
}
