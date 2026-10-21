import {
  placementName,
  platformName,
  type ClientResult,
  type DroppedTarget,
} from "./composer-lib";
import { PlatformBadge, Spinner } from "./ui";
import { PLATFORM_MAP, type PlatformId } from "@/lib/platforms";

export interface ResultPanelState {
  accountId: string;
  accountName: string;
  /** id van de geschiedenis-entry (voor 'Opnieuw proberen'). */
  historyId?: string;
  results: ClientResult[];
  dropped: DroppedTarget[];
  /** Algemene fout (bv. time-out: onbekend wat er geplaatst is). */
  error?: string;
  retrying?: boolean;
  retryError?: string;
}

/** Blijvend resultaatpaneel na een echte post — blijft staan tot 'Nieuwe post'. */
export function ResultPanel({
  state,
  onRetry,
  onNewPost,
}: {
  state: ResultPanelState;
  onRetry: () => void;
  onNewPost: () => void;
}) {
  const okCount = state.results.filter((r) => r.ok).length;
  const failed = state.results.filter((r) => !r.ok);
  const allOk = state.results.length > 0 && failed.length === 0 && !state.error;
  /** Geslaagde Instagram feed-post/Reel: herinnering om 'm zelf op de story te delen. */
  const igPost = state.results.find(
    (r) => r.ok && r.platform === "instagram" && r.placement !== "story",
  );
  const tone = allOk
    ? "border-accent/40 bg-accent/10"
    : okCount > 0
      ? "border-amber-500/40 bg-amber-500/10"
      : "border-red-500/40 bg-red-500/10";

  return (
    <section
      aria-live="polite"
      className={`rounded-2xl border p-4 ${tone}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">
          {allOk
            ? "✓ Gepost"
            : okCount > 0
              ? "Gedeeltelijk gepost"
              : state.results.length
                ? "Posten mislukt"
                : "Status onbekend"}{" "}
          <span className="text-muted">· {state.accountName}</span>
        </h2>
        {state.results.length > 0 && (
          <span className="text-xs text-muted">
            {okCount}/{state.results.length} gelukt
          </span>
        )}
      </div>

      {state.error && <p className="mt-2 text-xs text-red-300">{state.error}</p>}

      {state.results.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {state.results.map((r, i) => (
            <li
              key={`${r.platform}-${r.placement}-${i}`}
              className="flex items-start gap-2.5 rounded-lg border border-border bg-surface/80 px-3 py-2"
            >
              {PLATFORM_MAP[r.platform as PlatformId] ? (
                <PlatformBadge id={r.platform as PlatformId} small />
              ) : (
                <span className="h-6 w-6" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {platformName(r.platform)} · {placementName(r.platform, r.placement)}
                </p>
                {!r.ok && r.error && (
                  <p className="mt-0.5 text-[11px] text-red-400">{r.error}</p>
                )}
                {r.note && <p className="mt-0.5 text-[11px] text-amber-300/90">{r.note}</p>}
              </div>
              {r.ok ? (
                <span className="flex shrink-0 items-center gap-2 text-sm">
                  <span className="text-accent">✓</span>
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground transition hover:border-brand"
                    >
                      Bekijk ↗
                    </a>
                  )}
                </span>
              ) : (
                <span className="shrink-0 text-sm text-red-400">✗</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {igPost?.url && (
        <div className="mt-3 rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-xs">
          <p className="font-medium">📲 Zet de post nu op je Instagram-story</p>
          <p className="mt-0.5 text-muted">
            Open de post in de Instagram-app, tik op het vliegtuigje en kies{" "}
            <span className="text-foreground">Post toevoegen aan je verhaal</span>. Dan kunnen
            kijkers op je story doortikken naar de post.
          </p>
          <a
            href={igPost.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-brand underline-offset-2 hover:underline"
          >
            Open de post ↗
          </a>
        </div>
      )}

      {state.dropped.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-200/90">
          Overgeslagen:{" "}
          {state.dropped
            .map((d) => `${platformName(d.platform)} ${placementName(d.platform, d.placement)} (${d.reason})`)
            .join(", ")}
        </p>
      )}
      {state.retryError && <p className="mt-2 text-xs text-red-300">{state.retryError}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {state.historyId && failed.length > 0 && (
          <button
            type="button"
            onClick={onRetry}
            disabled={state.retrying}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium transition hover:border-brand disabled:opacity-60"
          >
            {state.retrying ? (
              <span className="flex items-center gap-2">
                <Spinner /> Bezig…
              </span>
            ) : (
              "↻ Opnieuw proberen (alleen mislukte)"
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onNewPost}
          disabled={state.retrying}
          className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-black transition hover:brightness-110 disabled:opacity-60"
        >
          ＋ Nieuwe post
        </button>
        <a
          href={`/planning?account=${encodeURIComponent(state.accountId)}`}
          className="ml-auto text-xs text-brand underline-offset-2 hover:underline"
        >
          Bekijk in Planning →
        </a>
      </div>
    </section>
  );
}
