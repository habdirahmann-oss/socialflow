import { useEffect } from "react";
import {
  formatWhen,
  placementName,
  platformName,
  targetList,
  type ClientResult,
  type DroppedTarget,
  type PublishTargets,
} from "./composer-lib";
import { PlatformBadge, Spinner } from "./ui";

export type ModalMode = "now" | "test" | "schedule";

export interface ModalState {
  mode: ModalMode;
  accountId: string;
  accountName: string;
  /** Genormaliseerde plaatsingen (client-side, via normalizeTargets). */
  targets: PublishTargets;
  /** Wat de client al liet vallen (bv. FB-story). */
  clientDropped: DroppedTarget[];
  scheduledFor?: number;
  /** Client-id voor idempotent inplannen (T2). */
  scheduleId?: string;
  phase: "checking" | "ready" | "error" | "submitting";
  dry?: { results: ClientResult[]; dropped: DroppedTarget[] };
  /** Fout van de dry-run zelf (bv. account niet verbonden). */
  error?: string;
  /** Fout bij bevestigen (inplannen/posten). */
  submitError?: string;
}

function dedupeDropped(list: DroppedTarget[]): DroppedTarget[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = `${d.platform}|${d.placement}|${d.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function ConfirmModal({
  state,
  onConfirm,
  onClose,
  onRecheck,
}: {
  state: ModalState;
  onConfirm: () => void;
  onClose: () => void;
  onRecheck: () => void;
}) {
  const { mode, phase, dry } = state;
  const busy = phase === "submitting";

  // Esc sluit (niet tijdens het versturen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const results = dry?.results ?? [];
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const dropped = dedupeDropped([...(state.clientDropped || []), ...(dry?.dropped || [])]);
  const planned = targetList(state.targets);
  const checked = phase !== "checking" && !state.error;
  const allFailed = checked && okCount === 0;

  const resultFor = (platform: string, placement: string) =>
    results.find((r) => r.platform === platform && r.placement === placement);

  const confirmLabel =
    mode === "schedule"
      ? okCount && failCount
        ? `Bevestig & plan ${okCount} in`
        : "Bevestig & plan in"
      : okCount && failCount
        ? `Bevestig & post ${okCount}`
        : "Bevestig & post";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] sm:items-center"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {mode === "test"
            ? "🧪 Testmodus — er wordt niets geplaatst"
            : mode === "schedule"
              ? "Inplannen"
              : "Nu posten"}
        </p>
        <h2 id="confirm-title" className="mt-1 text-2xl font-bold leading-tight">
          {mode === "schedule" ? "Inplannen voor " : "Posten naar "}
          <span className="text-accent">{state.accountName.toUpperCase()}</span>
        </h2>
        {mode === "schedule" && state.scheduledFor && (
          <p className="mt-1 text-sm text-muted">
            🗓️ {formatWhen(state.scheduledFor)} — wordt meestal binnen ~5–15 minuten na dat
            tijdstip geplaatst
          </p>
        )}

        <div className="mt-4 flex items-center gap-2 text-xs text-muted">
          {phase === "checking" ? (
            <>
              <Spinner /> Controle (dry-run) loopt — er wordt niets geplaatst…
            </>
          ) : state.error ? (
            <span className="text-red-600">Controle mislukt: {state.error}</span>
          ) : (
            <span>
              Controle klaar: <span className="text-accent">{okCount} klaar</span>
              {failCount > 0 && <span className="text-red-600"> · {failCount} mislukt</span>}
            </span>
          )}
        </div>

        <ul className="mt-3 flex flex-col gap-1.5">
          {planned.map(({ platform, placement }) => {
            const r = resultFor(platform, placement);
            return (
              <li
                key={`${platform}-${placement}`}
                className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/40 px-3 py-2"
              >
                <PlatformBadge id={platform} small />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {platformName(platform)} · {placementName(platform, placement)}
                  </p>
                  {r && !r.ok && r.error && (
                    <p className="mt-0.5 text-[11px] text-red-600">{r.error}</p>
                  )}
                </div>
                <span className="shrink-0 text-sm">
                  {phase === "checking" ? (
                    <span className="text-muted">…</span>
                  ) : r ? (
                    r.ok ? (
                      <span className="text-accent">✓</span>
                    ) : (
                      <span className="text-red-600">✗</span>
                    )
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </span>
              </li>
            );
          })}
          {planned.length === 0 && (
            <li className="text-xs text-muted">Geen plaatsingen die met deze media kunnen.</li>
          )}
        </ul>

        {dropped.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <p className="text-[11px] font-semibold text-amber-700">Overgeslagen</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {dropped.map((d) => (
                <li
                  key={`${d.platform}-${d.placement}-${d.reason}`}
                  className="text-[11px] text-amber-700"
                >
                  ✗ {platformName(d.platform)} · {placementName(d.platform, d.placement)} —{" "}
                  {d.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {mode === "schedule" && allFailed && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
            Inplannen geweigerd: geen enkel kanaal komt door de controle. Los de fouten
            hierboven op (bijv. koppel het kanaal opnieuw via Kanalen).
          </p>
        )}
        {mode !== "test" && checked && okCount > 0 && failCount > 0 && (
          <p className="mt-3 text-xs text-amber-700">
            Alleen de {okCount} geslaagde {okCount === 1 ? "plaatsing wordt" : "plaatsingen worden"}{" "}
            {mode === "schedule" ? "ingepland" : "geplaatst"}; de mislukte worden overgeslagen.
          </p>
        )}
        {state.submitError && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
            {state.submitError}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {(state.error || (checked && failCount > 0)) && !busy && (
            <button
              type="button"
              onClick={onRecheck}
              className="mr-auto rounded-lg border border-border px-3 py-2 text-xs text-muted transition hover:text-foreground"
            >
              ↻ Opnieuw controleren
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition hover:text-foreground disabled:opacity-50"
          >
            {mode === "test" ? "Sluiten" : "Annuleren"}
          </button>
          {mode !== "test" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={phase !== "ready" || okCount === 0}
              className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <Spinner /> Bezig…
                </span>
              ) : (
                confirmLabel
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
