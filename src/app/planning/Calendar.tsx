"use client";

import { useMemo, useState } from "react";
import PlatformBadge from "@/components/PlatformBadge";
import type { PostView } from "@/lib/post-view";

const WEEKDAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const MONTHS = [
  "januari",
  "februari",
  "maart",
  "april",
  "mei",
  "juni",
  "juli",
  "augustus",
  "september",
  "oktober",
  "november",
  "december",
];

const STATUS_STYLE: Record<string, string> = {
  pending: "border-brand/30 bg-brand/10 text-brand",
  processing: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  posted: "border-accent/30 bg-accent/10 text-accent",
  partial: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  failed: "border-red-500/40 bg-red-500/10 text-red-600",
};

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Maandkalender (Metricool-stijl): geplande en geplaatste posts per dag.
 * Klik op een geplande post om 'm in de lijst te bewerken.
 */
export default function Calendar({
  posts,
  timeOf,
  channelsOf,
  onOpen,
}: {
  posts: PostView[];
  /** Tijdstip om op te sorteren/plaatsen (gepland of geplaatst). */
  timeOf: (p: PostView) => number;
  channelsOf: (p: PostView) => string[];
  onOpen: (p: PostView) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const byDay = useMemo(() => {
    const map = new Map<string, PostView[]>();
    for (const p of posts) {
      const k = dayKey(new Date(timeOf(p)));
      map.set(k, [...(map.get(k) || []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => timeOf(a) - timeOf(b));
    return map;
  }, [posts, timeOf]);

  // Raster van maandag vóór de 1e t/m zondag na de laatste dag.
  const days = useMemo(() => {
    const first = new Date(cursor);
    const offset = (first.getDay() + 6) % 7; // maandag = 0
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const total = Math.ceil((offset + last.getDate()) / 7) * 7;
    return Array.from(
      { length: total },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
  }, [cursor]);

  const todayKey = dayKey(new Date());
  const move = (n: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-base font-semibold capitalize">
          {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => move(-1)}
            className="rounded-lg border border-border px-2.5 py-1 text-sm hover:bg-surface-2"
            aria-label="Vorige maand"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date();
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-surface-2"
          >
            Vandaag
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            className="rounded-lg border border-border px-2.5 py-1 text-sm hover:bg-surface-2"
            aria-label="Volgende maand"
          >
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-border bg-surface-2/60 text-center text-[11px] font-medium uppercase tracking-wide text-muted">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === cursor.getMonth();
          const list = byDay.get(k) || [];
          return (
            <div
              key={k}
              className={`min-h-24 border-border p-1.5 ${i % 7 !== 6 ? "border-r" : ""} ${
                i < days.length - 7 ? "border-b" : ""
              } ${inMonth ? "" : "bg-surface-2/40"}`}
            >
              <div
                className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                  k === todayKey
                    ? "bg-brand font-semibold text-white"
                    : inMonth
                      ? "text-foreground"
                      : "text-muted/60"
                }`}
              >
                {d.getDate()}
              </div>
              <div className="flex flex-col gap-1">
                {list.slice(0, 3).map((p) => {
                  const t = new Date(timeOf(p));
                  return (
                    <button
                      key={`${p.source}-${p.id}`}
                      type="button"
                      onClick={() => onOpen(p)}
                      title={p.subject}
                      className={`flex w-full items-center gap-1 rounded-md border px-1 py-0.5 text-left text-[10px] leading-tight ${
                        STATUS_STYLE[p.status] || "border-border"
                      }`}
                    >
                      <span className="shrink-0 font-semibold">
                        {pad(t.getHours())}:{pad(t.getMinutes())}
                      </span>
                      <span className="flex shrink-0 -space-x-1.5 [&>span]:h-4 [&>span]:w-4 [&>span]:rounded [&>span]:text-[7px]">
                        {channelsOf(p).map((c) => (
                          <PlatformBadge key={c} id={c} />
                        ))}
                      </span>
                      <span className="min-w-0 truncate">{p.subject}</span>
                    </button>
                  );
                })}
                {list.length > 3 && (
                  <span className="px-1 text-[10px] text-muted">+{list.length - 3} meer</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
