import AppNav from "@/components/AppNav";
import { PLATFORMS, PLATFORM_MAP, type PlatformId } from "@/lib/platforms";
import type { PostView } from "@/lib/post-view";

/** Laatste geschiedenis-tijdstip: direct = aangemaakt, gepland = laatst bijgewerkt. */
export function historyTime(p: PostView): number {
  if (p.source === "direct") return p.createdAt ?? p.scheduledFor;
  return p.updatedAt ?? p.scheduledFor;
}

const STATUS_NL: Record<PostView["status"], { label: string; cls: string }> = {
  pending: { label: "gepland", cls: "bg-brand/15 text-brand" },
  processing: { label: "bezig", cls: "bg-sky-500/15 text-sky-300" },
  posted: { label: "gepost", cls: "bg-accent/15 text-accent" },
  partial: { label: "gedeeltelijk", cls: "bg-amber-500/15 text-amber-400" },
  failed: { label: "mislukt", cls: "bg-red-500/15 text-red-400" },
};

export function MiniPost({
  post: p,
  time,
  onCancel,
}: {
  post: PostView;
  time: number;
  onCancel?: () => void;
}) {
  const platforms = Object.entries(p.targets || {})
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k]) => k as PlatformId)
    .filter((k) => PLATFORM_MAP[k]);
  const failed = (p.results || []).filter((r) => !r.ok);
  const status = STATUS_NL[p.status] ?? STATUS_NL.pending;
  const url = p.mediaUrl && /^(https?:|\/)/.test(p.mediaUrl) ? p.mediaUrl : undefined;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2/40 p-2">
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-black">
        {p.mediaType === "video" && url ? (
          <video
            src={url}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : p.mediaType === "image" && (p.thumb || url) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.thumb || url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm">📝</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{p.subject}</p>
        <div className="mt-0.5 flex items-center gap-1">
          {platforms.map((pid) => (
            <PlatformBadge key={pid} id={pid} small />
          ))}
          <span className="ml-1 text-[11px] text-muted">
            {new Date(time).toLocaleString("nl-NL", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        {p.status === "processing" && p.source === "direct" ? (
          <p className="mt-0.5 truncate text-[11px] text-sky-300">
            Bezig / onbekend — controleer het kanaal
          </p>
        ) : (
          p.status !== "posted" &&
          (p.lastError || failed.length > 0) && (
            <p className="mt-0.5 truncate text-[11px] text-red-400">
              {p.lastError || failed[0].error}
            </p>
          )
        )}
      </div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${status.cls}`}>
        {p.dryRun ? "🧪 " : ""}
        {status.label}
      </span>
      {onCancel && (
        <button
          onClick={onCancel}
          className="text-muted transition hover:text-red-400"
          title="Annuleren"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function Header({
  connected,
  accountName,
}: {
  /** aantal GEKOPPELDE kanalen van het gekozen account */
  connected: number;
  accountName?: string;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="SocialFlow" className="h-9 w-9 rounded-xl" />
          <div>
            <h1 className="text-base font-bold leading-none">SocialFlow</h1>
            <p className="text-[11px] text-muted">één post · alle kanalen</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="hidden items-center gap-2 sm:flex">
            {PLATFORMS.map((p) => (
              <PlatformBadge key={p.id} id={p.id} small />
            ))}
          </div>
          <span className="hidden rounded-full border border-border px-3 py-1 text-xs text-muted lg:block">
            {accountName ? `${accountName} · ` : ""}
            {connected} gekoppeld
          </span>
          <AppNav active="/" />
        </div>
      </div>
    </header>
  );
}

export function Card({
  children,
  title,
  step,
}: {
  children: React.ReactNode;
  title: string;
  step?: number;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        {step !== undefined && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/20 text-[11px] font-bold text-brand">
            {step}
          </span>
        )}
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function PlatformBadge({ id, small }: { id: PlatformId; small?: boolean }) {
  const p = PLATFORM_MAP[id];
  const size = small ? "h-6 w-6 text-[10px]" : "h-9 w-9 text-sm";
  const label: Record<PlatformId, string> = {
    instagram: "IG",
    tiktok: "TT",
    facebook: "f",
    youtube: "YT",
  };
  return (
    <span
      className={`flex ${size} items-center justify-center rounded-lg font-bold text-white`}
      style={{ background: p.gradient }}
      title={p.name}
    >
      {label[id]}
    </span>
  );
}

export function Switch({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${
        disabled ? "cursor-not-allowed bg-border/50 opacity-50" : on ? "bg-accent" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
          on ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export function SegBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${
        active
          ? "border-brand bg-brand/15 text-foreground"
          : "border-border bg-surface-2/40 text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
  );
}

export function EmptyState() {
  return (
    <div className="flex h-full min-h-[400px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface/40 p-8 text-center">
      <div className="mb-4 text-5xl">🪄</div>
      <h3 className="text-lg font-semibold">Je previews verschijnen hier</h3>
      <p className="mt-2 max-w-xs text-sm text-muted">
        Kies je account, leg je media klaar en klik op{" "}
        <span className="text-foreground">Genereer captions</span>. De AI maakt
        per platform een passende tekst — die je hier live ziet.
      </p>
    </div>
  );
}
