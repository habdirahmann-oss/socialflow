"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import PlatformBadge from "@/components/PlatformBadge";
import { PLATFORM_MAP, type PlatformId } from "@/lib/platforms";
import { postJson } from "@/lib/client-fetch";
import type { PostView } from "@/lib/post-view";

/* ---------------- Types & helpers ---------------- */

interface AccountLite {
  id: string;
  name: string;
}

interface CronRun {
  ranAt?: number;
}

type StatusChip = "gepland" | "gepost" | "gedeeltelijk" | "mislukt" | "alles";

const CHIPS: { id: StatusChip; label: string; statuses: PostView["status"][] | null }[] = [
  { id: "gepland", label: "Gepland", statuses: ["pending", "processing"] },
  { id: "gepost", label: "Gepost", statuses: ["posted"] },
  { id: "gedeeltelijk", label: "Gedeeltelijk", statuses: ["partial"] },
  { id: "mislukt", label: "Mislukt", statuses: ["failed"] },
  { id: "alles", label: "Alles", statuses: null },
];

/** Na zoveel minuten zonder cron-run tonen we een waarschuwing. */
const CRON_STALE_MS = 15 * 60_000;
/** Zo vaak verversen we de lijst automatisch. */
const POLL_MS = 30_000;
/** Een ingeplande post die zo lang 'processing' is, is waarschijnlijk vastgelopen. */
const STALE_PROCESSING_MS = 10 * 60_000;

const PLACEMENT_NL: Record<string, string> = {
  feed: "post",
  reel: "reel",
  story: "story",
  short: "short",
  video: "video",
};

function platformName(id: string): string {
  if (id === "-") return "Algemeen";
  return PLATFORM_MAP[id as PlatformId]?.name ?? id;
}

function placementName(platform: string, placement: string): string {
  if (placement === "-") return "";
  if (platform === "tiktok" && placement === "feed") return "video";
  return PLACEMENT_NL[placement] ?? placement;
}

function channelsOf(p: PostView): string[] {
  return Object.entries(p.targets || {})
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k]) => k);
}

function channelSummary(p: PostView): string {
  return Object.entries(p.targets || {})
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(
      ([k, v]) =>
        `${platformName(k)} (${(v as string[]).map((x) => placementName(k, x)).join(", ")})`,
    )
    .join(", ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** epoch ms → waarde voor <input type="datetime-local"> (lokale tijd). */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Groepsnaam voor de wachtrij: Vandaag / Morgen / <weekdag datum>. */
function dayLabel(ts: number, now: number): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  const tomorrow = startOfDay(today + 36 * 3600_000);
  if (day < today) return "Eerder — wacht op plaatsing";
  if (day === today) return "Vandaag";
  if (day === tomorrow) return "Morgen";
  const s = new Date(ts).toLocaleDateString("nl-NL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString("nl-NL", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Tijdstip waarop een geschiedenis-item 'gebeurde' (voor sorteren/tonen). */
function historyTime(p: PostView): number {
  if (p.source === "direct") return p.createdAt ?? p.scheduledFor;
  return p.updatedAt ?? p.scheduledFor;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/* ---------------- Page ---------------- */

export default function PlanningPage() {
  return (
    <Suspense>
      <Planning />
    </Suspense>
  );
}

function Planning() {
  const params = useSearchParams();
  const router = useRouter();
  const accountId = params.get("account") || "";

  const [accounts, setAccounts] = useState<AccountLite[]>([]);
  const [scheduled, setScheduled] = useState<PostView[]>([]);
  const [history, setHistory] = useState<PostView[]>([]);
  const [cron, setCron] = useState<CronRun | null>(null);
  const [cronLoaded, setCronLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chip, setChip] = useState<StatusChip>("alles");
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const reload = () => setReloadKey((k) => k + 1);

  const showToast = (msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), error ? 6000 : 3500);
  };

  /* accounts (één keer) */
  useEffect(() => {
    let cancelled = false;
    postJson<{ accounts?: AccountLite[] }>("/api/accounts", undefined, "GET")
      .then((d) => {
        if (!cancelled) {
          setAccounts((d.accounts || []).map((a) => ({ id: a.id, name: a.name })));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /* posts + geschiedenis + cron-status */
  useEffect(() => {
    let cancelled = false;
    const q = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
    Promise.all([
      postJson<{ posts?: PostView[] }>(`/api/schedule${q}`, undefined, "GET"),
      postJson<{ entries?: PostView[] }>(`/api/history${q}`, undefined, "GET"),
    ])
      .then(([s, h]) => {
        if (cancelled) return;
        setScheduled(s.posts || []);
        setHistory(h.entries || []);
        setLoadError(null);
        setLoaded(true);
        setNow(Date.now());
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(errMsg(e, "Laden mislukt"));
        setLoaded(true);
      });
    postJson<{ lastRun?: CronRun | null }>("/api/cron-status", undefined, "GET")
      .then((d) => {
        if (cancelled) return;
        setCron(d.lastRun ?? null);
        setCronLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId, reloadKey]);

  /* automatisch verversen */
  useEffect(() => {
    const t = setInterval(() => setReloadKey((k) => k + 1), POLL_MS);
    return () => clearInterval(t);
  }, []);

  const setAccount = (id: string) => {
    setEditing(null);
    router.replace(id ? `/planning?account=${encodeURIComponent(id)}` : "/planning", {
      scroll: false,
    });
  };

  /* ---------------- Afleidingen ---------------- */

  const allowed = CHIPS.find((c) => c.id === chip)?.statuses ?? null;

  const queue = useMemo(
    () =>
      scheduled
        .filter((p) => p.status === "pending" || p.status === "processing")
        .filter((p) => !allowed || allowed.includes(p.status))
        .sort((a, b) => a.scheduledFor - b.scheduledFor),
    [scheduled, allowed],
  );

  const queueGroups = useMemo(() => {
    const groups: { label: string; posts: PostView[] }[] = [];
    for (const p of queue) {
      const label = dayLabel(p.scheduledFor, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.posts.push(p);
      else groups.push({ label, posts: [p] });
    }
    return groups;
  }, [queue, now]);

  const past = useMemo(
    () =>
      [
        ...scheduled.filter((p) => p.status !== "pending" && p.status !== "processing"),
        ...history,
      ]
        .filter((p) => !allowed || allowed.includes(p.status))
        .sort((a, b) => historyTime(b) - historyTime(a)),
    [scheduled, history, allowed],
  );

  const accountName = (p: PostView) =>
    accounts.find((a) => a.id === p.accountId)?.name || p.accountName || "account";

  const cronStale =
    cronLoaded && (!cron?.ranAt || now - cron.ranAt > CRON_STALE_MS);

  /* ---------------- Acties ---------------- */

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
      reload();
    }
  };

  const cancelPost = (p: PostView) => {
    const finished = p.status !== "pending";
    const q = finished
      ? `Deze post uit de planning verwijderen?\n\n"${p.subject}"\n\n(Wat al geplaatst is, blijft op de kanalen staan.)`
      : `Geplande post annuleren?\n\n"${p.subject}" voor ${accountName(p)} op ${fmtDateTime(p.scheduledFor)}`;
    if (!window.confirm(q)) return;
    void run(p.id, async () => {
      try {
        await postJson(`/api/schedule?id=${encodeURIComponent(p.id)}`, undefined, "DELETE");
        showToast(finished ? "Verwijderd" : "Geannuleerd");
      } catch (e) {
        showToast(`Annuleren mislukt: ${errMsg(e, "onbekende fout")}`, true);
      }
    });
  };

  const postNow = (p: PostView) => {
    const q = p.dryRun
      ? `Testpost nu uitvoeren voor ${accountName(p)}?\n\nKanalen: ${channelSummary(p)}\n\n(Testmodus: er wordt niets echt geplaatst.)`
      : `Nu ECHT posten voor ${accountName(p)}?\n\nKanalen: ${channelSummary(p)}`;
    if (!window.confirm(q)) return;
    void run(p.id, async () => {
      try {
        const d = await postJson<{ post?: PostView | null; processed?: boolean }>(
          "/api/schedule/action",
          { id: p.id, action: "post-now" },
        );
        showToast(resultToast(d.post, d.processed));
      } catch (e) {
        showToast(`Nu posten mislukt: ${errMsg(e, "onbekende fout")}`, true);
      }
    });
  };

  const retry = (p: PostView) => {
    const failed = (p.results || []).filter((r) => !r.ok && r.platform !== "-");
    const what = failed.length
      ? failed.map((r) => `${platformName(r.platform)} ${placementName(r.platform, r.placement)}`).join(", ")
      : channelSummary(p);
    const q = p.dryRun
      ? `Test opnieuw uitvoeren voor ${accountName(p)}?\n\nAlleen wat nog niet gelukt is: ${what}`
      : `Opnieuw ECHT posten voor ${accountName(p)}?\n\nAlleen wat nog niet gelukt is: ${what}`;
    if (!window.confirm(q)) return;
    void run(p.id, async () => {
      try {
        if (p.source === "direct") {
          const d = await postJson<{ post?: PostView }>("/api/history/retry", { id: p.id });
          showToast(resultToast(d.post, true));
        } else {
          const d = await postJson<{ post?: PostView | null; processed?: boolean }>(
            "/api/schedule/action",
            { id: p.id, action: "retry" },
          );
          showToast(resultToast(d.post, d.processed));
        }
      } catch (e) {
        showToast(`Opnieuw proberen mislukt: ${errMsg(e, "onbekende fout")}`, true);
      }
    });
  };

  const saveEdit = async (
    p: PostView,
    patch: { scheduledFor: number; captions: PostView["captions"] },
  ): Promise<boolean> => {
    setBusy(p.id);
    try {
      await postJson(`/api/schedule?id=${encodeURIComponent(p.id)}`, patch, "PATCH");
      showToast("Opgeslagen");
      setEditing(null);
      return true;
    } catch (e) {
      showToast(`Opslaan mislukt: ${errMsg(e, "onbekende fout")}`, true);
      return false;
    } finally {
      setBusy(null);
      reload();
    }
  };

  /* ---------------- Render ---------------- */

  return (
    <AppShell
      active="/planning"
      title="Planning"
      subtitle="Wachtrij en geschiedenis van al je posts, per klant."
      actions={
        <button
          onClick={reload}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted shadow-sm transition hover:text-foreground"
        >
          ↻ Vernieuwen
        </button>
      }
    >

        {cronStale && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
            ⚠️ Automatisch plaatsen lijkt niet actief (laatste run:{" "}
            {cron?.ranAt ? fmtDateTime(cron.ranAt) : "nog nooit"}). Geplande posts
            worden pas geplaatst als de planner weer draait — gebruik zo nodig
            &lsquo;Nu posten&rsquo;.
          </div>
        )}

        {/* filters */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <select
            value={accountId}
            onChange={(e) => setAccount(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            aria-label="Klant"
          >
            <option value="">Alle klanten</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1.5">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                onClick={() => setChip(c.id)}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  chip === c.id
                    ? "border-brand bg-brand/15 text-foreground"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {loadError && (
          <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {loadError}
          </p>
        )}

        {/* Wachtrij */}
        {(chip === "alles" || chip === "gepland") && (
          <section className="mt-8">
            <h3 className="text-lg font-semibold">Wachtrij</h3>
            {!loaded ? (
              <p className="mt-3 text-sm text-muted">Laden…</p>
            ) : queueGroups.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                Niets ingepland{accountId ? " voor deze klant" : ""}. Plan iets in via{" "}
                <Link href="/" className="underline">
                  Nieuwe post
                </Link>
                .
              </p>
            ) : (
              queueGroups.map((g) => (
                <div key={g.label} className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    {g.label}
                  </p>
                  <div className="flex flex-col gap-2.5">
                    {g.posts.map((p) => (
                      <PostCard
                        key={p.id}
                        post={p}
                        account={accountName(p)}
                        now={now}
                        busy={busy === p.id}
                        editing={editing === p.id}
                        onEdit={() => setEditing(editing === p.id ? null : p.id)}
                        onCancel={() => cancelPost(p)}
                        onPostNow={() => postNow(p)}
                        onRetry={() => retry(p)}
                        onSave={(patch) => saveEdit(p, patch)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>
        )}

        {/* Geschiedenis */}
        {chip !== "gepland" || past.length > 0 ? (
          <section className="mt-10">
            <h3 className="text-lg font-semibold">Geschiedenis</h3>
            {!loaded ? (
              <p className="mt-3 text-sm text-muted">Laden…</p>
            ) : past.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                Nog niets in de geschiedenis.
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2.5">
                {past.map((p) => (
                  <PostCard
                    key={`${p.source}-${p.id}`}
                    post={p}
                    account={accountName(p)}
                    now={now}
                    busy={busy === p.id}
                    editing={false}
                    onEdit={() => {}}
                    onCancel={() => cancelPost(p)}
                    onPostNow={() => {}}
                    onRetry={() => retry(p)}
                    onSave={async () => false}
                  />
                ))}
              </div>
            )}
          </section>
        ) : null}

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 whitespace-pre-line rounded-xl border px-4 py-3 text-sm shadow-xl ${
            toast.error
              ? "border-red-500/40 bg-surface text-red-600"
              : "border-border bg-surface"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </AppShell>
  );
}

function resultToast(post: PostView | null | undefined, processed?: boolean): string {
  if (!post) return "Klaar";
  if (!processed) return "Wordt al verwerkt door de planner — even geduld";
  const test = post.dryRun ? "🧪 Test: " : "";
  switch (post.status) {
    case "posted":
      return `${test}Gepost op alle kanalen`;
    case "partial":
      return `${test}Gedeeltelijk gepost — zie de resultaten`;
    case "failed":
      return `${test}Mislukt: ${post.lastError ?? "onbekende fout"}`;
    case "pending":
      return `${test}Nog niet alles gelukt — nieuwe poging volgt automatisch${
        post.lastError ? ` (${post.lastError})` : ""
      }`;
    default:
      return `${test}Bezig…`;
  }
}

/* ---------------- Kaart ---------------- */

function StatusBadge({ post }: { post: PostView }) {
  const map: Record<PostView["status"], { label: string; cls: string }> = {
    pending: { label: "Gepland", cls: "bg-brand/15 text-brand" },
    processing: { label: "Bezig", cls: "bg-sky-500/15 text-sky-700" },
    posted: { label: "Gepost", cls: "bg-accent/15 text-accent" },
    partial: { label: "Gedeeltelijk", cls: "bg-amber-500/15 text-amber-700" },
    failed: { label: "Mislukt", cls: "bg-red-500/15 text-red-600" },
  };
  const s = map[post.status] ?? map.pending;
  return (
    <span className="flex items-center gap-1">
      {post.dryRun && (
        <span className="rounded-full bg-purple-500/15 px-2 py-0.5 text-[11px] text-purple-700">
          Test
        </span>
      )}
      <span className={`rounded-full px-2 py-0.5 text-[11px] ${s.cls}`}>{s.label}</span>
    </span>
  );
}

function Thumb({ post }: { post: PostView }) {
  const url = post.mediaUrl && /^(https?:|\/)/.test(post.mediaUrl) ? post.mediaUrl : undefined;
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-black">
      {post.mediaType === "video" && url ? (
        <video
          src={url}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
      ) : post.mediaType === "image" && (post.thumb || url) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={post.thumb || url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xl">
          {post.mediaType ? "🎞️" : "📝"}
        </div>
      )}
    </div>
  );
}

function PostCard({
  post: p,
  account,
  now,
  busy,
  editing,
  onEdit,
  onCancel,
  onPostNow,
  onRetry,
  onSave,
}: {
  post: PostView;
  account: string;
  now: number;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onPostNow: () => void;
  onRetry: () => void;
  onSave: (patch: { scheduledFor: number; captions: PostView["captions"] }) => Promise<boolean>;
}) {
  const isScheduled = p.source !== "direct";
  const isQueue = isScheduled && (p.status === "pending" || p.status === "processing");
  const when = isQueue ? p.scheduledFor : historyTime(p);
  const results = p.results || [];
  const unknownState =
    p.status === "processing" &&
    (p.source === "direct" || now - (p.processingAt ?? now) > STALE_PROCESSING_MS);

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex gap-3">
        <Thumb post={p} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{account}</span>
            <span className="text-xs text-muted">
              {isQueue ? fmtTime(when) : fmtDateTime(when)}
              {!isScheduled && " · direct"}
            </span>
            <span className="flex items-center gap-1">
              {channelsOf(p).map((c) => (
                <PlatformBadge key={c} id={c} />
              ))}
            </span>
            <span className="ml-auto">
              <StatusBadge post={p} />
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-muted">{p.subject}</p>

          {unknownState && (
            <p className="mt-1 text-xs text-sky-700">
              Bezig / onbekend — controleer het kanaal
            </p>
          )}
          {p.status === "pending" && (p.attempts ?? 0) > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              {p.lastError ? `${p.lastError} — ` : ""}
              nieuwe poging
              {p.nextAttemptAt ? ` rond ${fmtTime(p.nextAttemptAt)}` : ""} (poging{" "}
              {(p.attempts ?? 0) + 1}/3)
            </p>
          )}

          {results.length > 0 && (
            <ul className="mt-2 flex flex-col gap-0.5">
              {results.map((r) => (
                <li key={`${r.platform}:${r.placement}`} className="text-xs">
                  <span className="text-muted">
                    {platformName(r.platform)}
                    {placementName(r.platform, r.placement)
                      ? ` · ${placementName(r.platform, r.placement)}`
                      : ""}{" "}
                    ·{" "}
                  </span>
                  {r.ok ? (
                    <span className="text-accent">
                      ✓{" "}
                      {r.url ? (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          Bekijk
                        </a>
                      ) : p.dryRun ? (
                        "klaar (test)"
                      ) : (
                        "geplaatst"
                      )}
                    </span>
                  ) : (
                    <span className="text-red-600">✗ {r.error || "mislukt"}</span>
                  )}
                  {r.note && <span className="text-amber-700"> — {r.note}</span>}
                </li>
              ))}
            </ul>
          )}
          {results.length === 0 && p.lastError && p.status !== "pending" && (
            <p className="mt-1 text-xs text-red-600">✗ {p.lastError}</p>
          )}

          {/* acties */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {isScheduled && p.status === "pending" && (
              <>
                <ActionBtn onClick={onEdit} disabled={busy}>
                  {editing ? "Sluiten" : "Bewerken"}
                </ActionBtn>
                <ActionBtn onClick={onPostNow} disabled={busy}>
                  Nu posten
                </ActionBtn>
                <ActionBtn onClick={onCancel} disabled={busy} danger>
                  Annuleren
                </ActionBtn>
              </>
            )}
            {(p.status === "failed" || p.status === "partial") && (
              <ActionBtn onClick={onRetry} disabled={busy}>
                Opnieuw proberen
              </ActionBtn>
            )}
            {isScheduled && (p.status === "posted" || p.status === "failed" || p.status === "partial") && (
              <ActionBtn onClick={onCancel} disabled={busy} danger>
                Verwijderen
              </ActionBtn>
            )}
            {busy && <span className="self-center text-xs text-muted">Bezig…</span>}
          </div>

          {editing && <EditForm post={p} now={now} busy={busy} onSave={onSave} />}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border border-border bg-surface-2/60 px-2.5 py-1 text-xs transition disabled:opacity-50 ${
        danger ? "hover:border-red-500/60 hover:text-red-600" : "hover:border-brand"
      }`}
    >
      {children}
    </button>
  );
}

/* ---------------- Bewerken ---------------- */

type Caption = NonNullable<PostView["captions"]["facebook"]>;

function EditForm({
  post,
  now,
  busy,
  onSave,
}: {
  post: PostView;
  now: number;
  busy: boolean;
  onSave: (patch: { scheduledFor: number; captions: PostView["captions"] }) => Promise<boolean>;
}) {
  const channels = channelsOf(post);
  const [when, setWhen] = useState(() => toLocalInput(post.scheduledFor));
  const [drafts, setDrafts] = useState<Record<string, Caption>>(() => {
    const out: Record<string, Caption> = {};
    for (const c of channels) {
      const cur = post.captions?.[c as keyof PostView["captions"]];
      out[c] = {
        title: cur?.title ?? "",
        caption: cur?.caption ?? "",
        story: cur?.story ?? "",
        hashtags: cur?.hashtags ?? [],
      };
    }
    return out;
  });
  const [tagText, setTagText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      channels.map((c) => [
        c,
        (post.captions?.[c as keyof PostView["captions"]]?.hashtags ?? [])
          .map((h) => `#${h}`)
          .join(" "),
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);

  const update = (c: string, patch: Partial<Caption>) =>
    setDrafts((d) => ({ ...d, [c]: { ...d[c], ...patch } }));

  const submit = async () => {
    const ts = new Date(when).getTime();
    if (!when || Number.isNaN(ts)) {
      setError("Kies een geldige datum en tijd");
      return;
    }
    if (ts < Date.now() - 60_000) {
      setError("Kies een tijdstip in de toekomst");
      return;
    }
    setError(null);
    const captions: Record<string, Caption> = { ...(post.captions as Record<string, Caption>) };
    for (const c of channels) {
      captions[c] = {
        ...drafts[c],
        hashtags: (tagText[c] || "")
          .split(/[\s,]+/)
          .map((h) => h.replace(/^#+/, "").trim())
          .filter(Boolean),
      };
    }
    await onSave({ scheduledFor: ts, captions: captions as PostView["captions"] });
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface-2/40 p-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Tijdstip
        <input
          type="datetime-local"
          value={when}
          min={toLocalInput(now)}
          onChange={(e) => setWhen(e.target.value)}
          className="w-fit rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        />
      </label>
      {channels.map((c) => (
        <div key={c} className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <PlatformBadge id={c} /> {platformName(c)}
          </span>
          {c === "youtube" && (
            <input
              value={drafts[c]?.title ?? ""}
              onChange={(e) => update(c, { title: e.target.value })}
              placeholder="Titel"
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            />
          )}
          <textarea
            value={drafts[c]?.caption ?? ""}
            onChange={(e) => update(c, { caption: e.target.value })}
            rows={4}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            aria-label={`Caption ${platformName(c)}`}
          />
          <input
            value={tagText[c] ?? ""}
            onChange={(e) => setTagText((t) => ({ ...t, [c]: e.target.value }))}
            placeholder="#hashtags"
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
            aria-label={`Hashtags ${platformName(c)}`}
          />
        </div>
      ))}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div>
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-60"
        >
          {busy ? "Opslaan…" : "Opslaan"}
        </button>
      </div>
    </div>
  );
}
