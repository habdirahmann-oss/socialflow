"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLATFORMS,
  PLATFORM_MAP,
  TONES,
  type PlatformId,
  type PlacementId,
} from "@/lib/platforms";
import type { CaptionResult, PlatformCaption } from "./api/captions/route";
import LogoutLink from "@/components/LogoutLink";

/* ---------------- Types ---------------- */

interface MediaItem {
  url: string;
  type: "image" | "video";
  name: string;
}

interface ScheduledPost {
  id: string;
  subject: string;
  platforms: PlatformId[];
  placements: Record<string, PlacementId[]>;
  captions: CaptionResult;
  thumb?: string;
  thumbType?: "image" | "video";
  when: string; // ISO of "now"
  status: "gepland" | "gepost";
}

const STORE_KEY = "socialflow.posts.v1";

interface AccountInfo {
  id: string;
  name: string;
  facebook: boolean;
  instagram: boolean;
  pages: { id: string; name: string; instagram: string | null }[];
  igLogin: { username: string } | null;
  tiktok: { displayName: string } | null;
  youtube: { channelTitle: string } | null;
}

interface ServerPost {
  id: string;
  accountName: string;
  scheduledFor: number;
  thumb?: string;
  subject: string;
  targets: Record<string, string[]>;
  status: "pending" | "posted" | "failed";
  results?: { platform: string; placement: string; ok: boolean; error?: string }[];
}

/* ---------------- Page ---------------- */

export default function Page() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [subject, setSubject] = useState("");
  const [tone, setTone] = useState<string>(TONES[0]);
  const [selected, setSelected] = useState<Set<PlatformId>>(
    new Set(["instagram", "tiktok", "facebook", "youtube"]),
  );
  const [placements, setPlacements] = useState<Record<string, PlacementId[]>>({
    instagram: ["feed", "story"],
    tiktok: ["feed"],
    facebook: ["feed", "story"],
    youtube: ["short"],
  });
  const [captions, setCaptions] = useState<CaptionResult>({});
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<"now" | "later">("now");
  const [scheduleAt, setScheduleAt] = useState("");
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<PlatformId>("instagram");
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [publishing, setPublishing] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [serverPosts, setServerPosts] = useState<ServerPost[]>([]);

  /* load saved posts */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setPosts(JSON.parse(raw));
    } catch {}
  }, []);

  /* load accounts + connectiestatus */
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d) => {
        const list: AccountInfo[] = d.accounts || [];
        setAccounts(list);
        setAccountId((prev) => prev || list[0]?.id || "");
      })
      .catch(() => {});
  }, []);

  /* load server-side geplande posts */
  const loadSchedule = () => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((d) => setServerPosts(d.posts || []))
      .catch(() => {});
  };
  useEffect(() => {
    loadSchedule();
  }, []);

  const persist = (next: ScheduledPost[]) => {
    setPosts(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      // quota — bewaar zonder thumbnails
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify(next.map((p) => ({ ...p, thumb: undefined }))),
        );
      } catch {}
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  /* ---------------- Media ---------------- */
  const fileRef = useRef<HTMLInputElement>(null);

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        setMedia((m) => [
          ...m,
          {
            url: reader.result as string,
            type: file.type.startsWith("video") ? "video" : "image",
            name: file.name,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeMedia = (i: number) =>
    setMedia((m) => m.filter((_, idx) => idx !== i));

  /* ---------------- Platforms ---------------- */
  const togglePlatform = (id: PlatformId) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePlacement = (pid: PlatformId, plc: PlacementId) => {
    setPlacements((prev) => {
      const cur = prev[pid] || [];
      const next = cur.includes(plc)
        ? cur.filter((x) => x !== plc)
        : [...cur, plc];
      return { ...prev, [pid]: next };
    });
  };

  const selectedList = useMemo(
    () => PLATFORMS.filter((p) => selected.has(p.id)),
    [selected],
  );

  /* ---------------- AI captions ---------------- */
  const generate = async () => {
    if (selected.size === 0) {
      showToast("Kies eerst minstens één platform");
      return;
    }
    setLoading(true);
    setSource(null);
    try {
      const res = await fetch("/api/captions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          tone,
          platforms: Array.from(selected),
        }),
      });
      const data = await res.json();
      if (data.result) {
        setCaptions(data.result);
        setSource(data.source);
        if (!selected.has(activePreview)) {
          setActivePreview(Array.from(selected)[0]);
        }
        showToast(
          data.source === "claude"
            ? "Captions gegenereerd met Claude ✨"
            : "Captions gegenereerd (lokaal) — voeg een API-key toe voor slimmere teksten",
        );
      } else {
        showToast(data.error || "Genereren mislukt");
      }
    } catch {
      showToast("Kon de server niet bereiken");
    } finally {
      setLoading(false);
    }
  };

  const updateCaption = (pid: PlatformId, patch: Partial<PlatformCaption>) => {
    setCaptions((c) => ({ ...c, [pid]: { ...c[pid], ...patch } }));
  };

  /* ---------------- Publish ---------------- */
  const canPublish = selected.size > 0 && Object.keys(captions).length > 0;

  const currentAccount = accounts.find((a) => a.id === accountId);
  const conn = {
    facebook: Boolean(currentAccount?.facebook),
    instagram: Boolean(
      currentAccount?.instagram || currentAccount?.igLogin,
    ),
    tiktok: Boolean(currentAccount?.tiktok),
    youtube: Boolean(currentAccount?.youtube),
  };
  const metaConnected = conn.facebook || conn.instagram;
  const anyConnected =
    conn.facebook || conn.instagram || conn.tiktok || conn.youtube;
  // van de gekozen kanalen: welke zijn daadwerkelijk verbonden?
  const selectedConnected = Array.from(selected).filter(
    (p) => conn[p as keyof typeof conn],
  );

  // bouw targets/captions voor de gekozen kanalen
  const buildTargets = () => ({
    facebook: selected.has("facebook") ? placements.facebook || [] : [],
    instagram: selected.has("instagram") ? placements.instagram || [] : [],
    tiktok: selected.has("tiktok") ? placements.tiktok || [] : [],
    youtube: selected.has("youtube") ? placements.youtube || [] : [],
  });
  const buildCaptions = () => ({
    facebook: captions.facebook,
    instagram: captions.instagram,
    tiktok: captions.tiktok,
    youtube: captions.youtube,
  });
  const mediaPayload = () =>
    media[0] ? { dataUrl: media[0].url, type: media[0].type } : null;

  const publish = async () => {
    if (!canPublish) {
      showToast("Genereer eerst de captions");
      return;
    }
    const isNow = schedule === "now";

    /* ---------- Inplannen (server-side) ---------- */
    if (!isNow) {
      if (!scheduleAt) {
        showToast("Kies eerst een datum en tijd");
        return;
      }
      const ts = new Date(scheduleAt).getTime();
      if (isNaN(ts)) {
        showToast("Ongeldige datum/tijd");
        return;
      }
      if (ts < Date.now() - 60_000) {
        showToast("Kies een tijdstip in de toekomst");
        return;
      }
      setPublishing(true);
      try {
        const res = await fetch("/api/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId,
            accountName: currentAccount?.name,
            scheduledFor: ts,
            media: mediaPayload(),
            subject,
            targets: buildTargets(),
            captions: buildCaptions(),
          }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast("🗓️ Post ingepland — wordt automatisch geplaatst");
          loadSchedule();
        } else {
          showToast(data.error || "Inplannen mislukt");
        }
      } catch {
        showToast("Inplannen mislukt — server onbereikbaar");
      } finally {
        setPublishing(false);
      }
      return;
    }

    /* ---------- Nu posten (echt of testmodus) ---------- */
    setPublishing(true);
    let msg = "";
    let posted = false;
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId,
          media: mediaPayload(),
          targets: buildTargets(),
          captions: buildCaptions(),
          dryRun,
        }),
      });
      const data = await res.json();
      const results: { ok: boolean; error?: string; platform?: string }[] =
        data.results || [];
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (!results.length) {
        msg = data.error || "Geen plaatsingen verstuurd";
      } else if (dryRun) {
        msg = `🧪 Testmodus: ${okCount} klaar om te posten`;
        if (failed.length) msg += ` · ${failed.length} nog niet gekoppeld`;
      } else {
        posted = okCount > 0;
        if (okCount > 0) msg = `✓ Echt gepost (${okCount}×)`;
        if (failed.length)
          msg +=
            (msg ? " · " : "") +
            `${failed.length} mislukt: ${failed[0].error ?? ""}`;
      }
    } catch {
      msg = "Posten mislukt — server onbereikbaar";
    } finally {
      setPublishing(false);
    }

    // log alleen echte posts in de lokale geschiedenis
    if (posted) {
      const post: ScheduledPost = {
        id: `${Date.now()}`,
        subject: subject || "(zonder onderwerp)",
        platforms: Array.from(selected),
        placements,
        captions,
        thumb: media[0]?.url,
        thumbType: media[0]?.type,
        when: "now",
        status: "gepost",
      };
      persist([post, ...posts]);
    }
    showToast(msg);
  };

  const cancelScheduled = async (id: string) => {
    setServerPosts((s) => s.filter((p) => p.id !== id));
    try {
      await fetch(`/api/schedule?id=${id}`, { method: "DELETE" });
    } catch {}
    loadSchedule();
  };

  const deletePost = (id: string) => persist(posts.filter((p) => p.id !== id));

  const activeCaption = captions[activePreview];

  /* ---------------- Render ---------------- */
  return (
    <div className="min-h-screen">
      <Header connected={selected.size} />

      <main className="mx-auto max-w-7xl px-4 pb-24 pt-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr]">
          {/* LEFT — composer */}
          <div className="flex flex-col gap-5">
            {/* 1. media */}
            <Card step={1} title="Leg je content klaar">
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onFiles(e.dataTransfer.files);
                }}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-surface-2/40 px-4 py-8 text-center transition hover:border-brand hover:bg-surface-2"
              >
                <div className="mb-2 text-3xl">📤</div>
                <p className="text-sm font-medium">
                  Sleep foto&apos;s of video&apos;s hierheen
                </p>
                <p className="mt-1 text-xs text-muted">of klik om te kiezen</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  hidden
                  onChange={(e) => onFiles(e.target.files)}
                />
              </div>

              {media.length > 0 && (
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {media.map((m, i) => (
                    <div
                      key={i}
                      className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-black"
                    >
                      {m.type === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={m.url}
                          alt={m.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <video
                          src={m.url}
                          className="h-full w-full object-cover"
                          muted
                        />
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeMedia(i);
                        }}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white opacity-0 transition group-hover:opacity-100"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* 2. idee + toon */}
            <Card step={2} title="Waar gaat het over? (optioneel)">
              <textarea
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                rows={3}
                placeholder="Bijv. nieuwe zomercollectie, 20% korting dit weekend…"
                className="w-full resize-none rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-brand"
              />
              <p className="mb-2 mt-4 text-xs font-medium text-muted">Toon</p>
              <div className="flex flex-wrap gap-2">
                {TONES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTone(t)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      tone === t
                        ? "border-brand bg-brand/20 text-foreground"
                        : "border-border bg-surface-2/40 text-muted hover:text-foreground"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Card>

            {/* 3. kanalen */}
            <Card step={3} title="Kies je kanalen">
              <div className="flex flex-col gap-2">
                {PLATFORMS.map((p) => {
                  const on = selected.has(p.id);
                  return (
                    <div
                      key={p.id}
                      className={`rounded-xl border p-3 transition ${
                        on
                          ? "border-border bg-surface-2/60"
                          : "border-border/50 bg-transparent opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => togglePlatform(p.id)}
                          className="flex items-center gap-3"
                        >
                          <PlatformBadge id={p.id} />
                          <div className="text-left">
                            <p className="text-sm font-semibold">{p.name}</p>
                            <p className="text-xs text-muted">{p.blurb}</p>
                          </div>
                        </button>
                        <Switch on={on} onClick={() => togglePlatform(p.id)} />
                      </div>
                      {on && (
                        <div className="mt-3 flex flex-wrap gap-1.5 pl-1">
                          {p.placements.map((plc) => {
                            const active = (placements[p.id] || []).includes(
                              plc.id,
                            );
                            return (
                              <button
                                key={plc.id}
                                onClick={() => togglePlacement(p.id, plc.id)}
                                className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
                                  active
                                    ? "border-accent/60 bg-accent/15 text-accent"
                                    : "border-border bg-surface-2/40 text-muted hover:text-foreground"
                                }`}
                              >
                                {active ? "✓ " : ""}
                                {plc.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* generate button */}
            <button
              onClick={generate}
              disabled={loading}
              className="group relative overflow-hidden rounded-xl bg-gradient-to-r from-brand to-brand-2 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-brand/20 transition hover:brightness-110 disabled:opacity-60"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner /> AI schrijft je captions…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  ✨ Genereer captions met AI
                </span>
              )}
            </button>
          </div>

          {/* RIGHT — previews */}
          <div className="flex flex-col gap-5">
            {Object.keys(captions).length === 0 ? (
              <EmptyState />
            ) : (
              <>
                {/* tabs */}
                <div className="flex flex-wrap items-center gap-2">
                  {selectedList.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setActivePreview(p.id)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
                        activePreview === p.id
                          ? "border-brand bg-brand/15"
                          : "border-border bg-surface text-muted hover:text-foreground"
                      }`}
                    >
                      <PlatformBadge id={p.id} small />
                      {p.name}
                    </button>
                  ))}
                  {source && (
                    <span className="ml-auto rounded-full border border-border px-2.5 py-1 text-[11px] text-muted">
                      bron: {source === "claude" ? "Claude AI" : "lokaal"}
                    </span>
                  )}
                </div>

                {activeCaption && (
                  <div className="grid grid-cols-1 gap-5 xl:grid-cols-[300px_1fr]">
                    {/* phone preview */}
                    <div className="flex flex-col items-center gap-3">
                      <PhonePreview
                        platform={activePreview}
                        media={media[0]}
                        caption={activeCaption}
                        placements={placements[activePreview] || []}
                      />
                    </div>

                    {/* editable caption */}
                    <CaptionEditor
                      platform={activePreview}
                      caption={activeCaption}
                      onChange={(patch) => updateCaption(activePreview, patch)}
                    />
                  </div>
                )}

                {/* publish bar */}
                <Card title="Publiceren">
                  <div className="flex flex-col gap-4">
                    {/* account-keuze */}
                    <div>
                      <label className="mb-1 block text-xs text-muted">
                        Posten vanuit account
                      </label>
                      <select
                        value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {(
                          [
                            ["facebook", "Facebook"],
                            ["instagram", "Instagram"],
                            ["tiktok", "TikTok"],
                            ["youtube", "YouTube"],
                          ] as [PlatformId, string][]
                        ).map(([id, label]) => {
                          const ok = conn[id as keyof typeof conn];
                          return (
                            <span
                              key={id}
                              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                                ok
                                  ? "border-accent/40 bg-accent/10 text-accent"
                                  : "border-border bg-surface-2/40 text-muted"
                              }`}
                            >
                              {ok ? "✓ " : "○ "}
                              {label}
                            </span>
                          );
                        })}
                        {!anyConnected && (
                          <a
                            href="/verbindingen"
                            className="text-[11px] text-amber-300/90 underline"
                          >
                            koppel via Verbindingen
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <SegBtn
                        active={schedule === "now"}
                        onClick={() => setSchedule("now")}
                      >
                        🚀 Nu posten
                      </SegBtn>
                      <SegBtn
                        active={schedule === "later"}
                        onClick={() => setSchedule("later")}
                      >
                        🗓️ Inplannen
                      </SegBtn>
                    </div>
                    {schedule === "later" && (
                      <input
                        type="datetime-local"
                        value={scheduleAt}
                        onChange={(e) => setScheduleAt(e.target.value)}
                        className="rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                    )}
                    {schedule === "now" && (
                      <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                        <span className="flex items-center gap-2 text-xs">
                          🧪 Testmodus
                          <span className="text-muted">
                            (controleer koppeling, post niets)
                          </span>
                        </span>
                        <Switch on={dryRun} onClick={() => setDryRun(!dryRun)} />
                      </label>
                    )}
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted">
                        Gaat naar{" "}
                        <span className="text-foreground">{selected.size}</span>{" "}
                        kanalen
                        {selectedConnected.length > 0 && (
                          <span className="text-accent">
                            {" "}
                            · {selectedConnected.length} verbonden
                          </span>
                        )}
                      </p>
                      <button
                        onClick={publish}
                        disabled={publishing}
                        className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-60"
                      >
                        {publishing ? (
                          <span className="flex items-center gap-2">
                            <Spinner /> Bezig…
                          </span>
                        ) : schedule === "later" ? (
                          "Plan in"
                        ) : dryRun ? (
                          "🧪 Test"
                        ) : (
                          "Post nu"
                        )}
                      </button>
                    </div>
                    {anyConnected ? (
                      <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[11px] text-accent/90">
                        ✓ Verbonden kanalen posten écht
                        {conn.tiktok ? "" : " (TikTok volgt na goedkeuring)"}.
                        Niet-gekoppelde kanalen worden overgeslagen — koppel ze
                        via{" "}
                        <a href="/verbindingen" className="underline">
                          Verbindingen
                        </a>
                        .
                      </p>
                    ) : (
                      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300/90">
                        ⚠️ Dit account is nog niet gekoppeld. Koppel eerst via{" "}
                        <a href="/verbindingen" className="underline">
                          Verbindingen
                        </a>
                        , dan posten je kanalen automatisch.
                      </p>
                    )}
                  </div>
                </Card>
              </>
            )}

            {/* server-side ingeplande posts */}
            {serverPosts.length > 0 && (
              <Card title="Automatisch ingepland">
                <div className="flex flex-col gap-2">
                  {serverPosts
                    .slice()
                    .sort((a, b) => a.scheduledFor - b.scheduledFor)
                    .map((p) => {
                      const platforms = Object.entries(p.targets || {})
                        .filter(([, v]) => (v as string[]).length > 0)
                        .map(([k]) => k as PlatformId);
                      const failed = (p.results || []).filter((r) => !r.ok);
                      return (
                        <div
                          key={p.id}
                          className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 p-2.5"
                        >
                          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-black">
                            {p.thumb ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={p.thumb}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-lg">
                                🗓️
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {p.subject}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {platforms.map((pid) => (
                                <PlatformBadge key={pid} id={pid} small />
                              ))}
                              <span className="ml-1 text-[11px] text-muted">
                                {new Date(p.scheduledFor).toLocaleString(
                                  "nl-NL",
                                  {
                                    day: "numeric",
                                    month: "short",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </span>
                            </div>
                            {failed.length > 0 && (
                              <p className="mt-1 truncate text-[11px] text-red-400">
                                {failed[0].error}
                              </p>
                            )}
                          </div>
                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] ${
                              p.status === "posted"
                                ? "bg-accent/15 text-accent"
                                : p.status === "failed"
                                  ? "bg-red-500/15 text-red-400"
                                  : "bg-brand/15 text-brand"
                            }`}
                          >
                            {p.status === "posted"
                              ? "gepost"
                              : p.status === "failed"
                                ? "mislukt"
                                : "gepland"}
                          </span>
                          {p.status === "pending" && (
                            <button
                              onClick={() => cancelScheduled(p.id)}
                              className="text-muted transition hover:text-red-400"
                              title="Annuleren"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </Card>
            )}

            {/* scheduled posts */}
            {posts.length > 0 && (
              <Card title="Geplande & geposte content">
                <div className="flex flex-col gap-2">
                  {posts.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 p-2.5"
                    >
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-black">
                        {p.thumb ? (
                          p.thumbType === "video" ? (
                            <video
                              src={p.thumb}
                              className="h-full w-full object-cover"
                              muted
                            />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={p.thumb}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          )
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-lg">
                            📝
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {p.subject}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5">
                          {p.platforms.map((pid) => (
                            <PlatformBadge key={pid} id={pid} small />
                          ))}
                          <span className="ml-1 text-[11px] text-muted">
                            {p.when === "now"
                              ? "zojuist"
                              : new Date(p.when).toLocaleString("nl-NL", {
                                  day: "numeric",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                          </span>
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] ${
                          p.status === "gepost"
                            ? "bg-accent/15 text-accent"
                            : "bg-brand/15 text-brand"
                        }`}
                      >
                        {p.status}
                      </span>
                      <button
                        onClick={() => deletePost(p.id)}
                        className="text-muted transition hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      </main>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ---------------- Sub-components ---------------- */

function Header({ connected }: { connected: number }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="SocialFlow" className="h-9 w-9 rounded-xl" />
          <div>
            <h1 className="text-base font-bold leading-none">SocialFlow</h1>
            <p className="text-[11px] text-muted">één post · alle kanalen</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {PLATFORMS.map((p) => (
            <PlatformBadge key={p.id} id={p.id} small />
          ))}
          <a
            href="/verbindingen"
            className="ml-2 rounded-full border border-border px-3 py-1 text-xs text-muted transition hover:text-foreground"
          >
            🔗 Verbindingen
          </a>
          <span className="hidden rounded-full border border-border px-3 py-1 text-xs text-muted sm:block">
            {connected} actief
          </span>
          <LogoutLink className="ml-1" />
        </div>
      </div>
    </header>
  );
}

function Card({
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
        {step && (
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

function PlatformBadge({ id, small }: { id: PlatformId; small?: boolean }) {
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

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative h-6 w-11 rounded-full transition ${
        on ? "bg-accent" : "bg-border"
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

function SegBtn({
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

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[400px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface/40 p-8 text-center">
      <div className="mb-4 text-5xl">🪄</div>
      <h3 className="text-lg font-semibold">Je previews verschijnen hier</h3>
      <p className="mt-2 max-w-xs text-sm text-muted">
        Leg je media klaar, kies je kanalen en klik op{" "}
        <span className="text-foreground">Genereer captions</span>. De AI maakt
        per platform een passende tekst — die je hier live ziet.
      </p>
    </div>
  );
}

function CaptionEditor({
  platform,
  caption,
  onChange,
}: {
  platform: PlatformId;
  caption: PlatformCaption;
  onChange: (patch: Partial<PlatformCaption>) => void;
}) {
  const p = PLATFORM_MAP[platform];
  const len = caption.caption.length;
  return (
    <Card title={`Tekst voor ${p.name}`}>
      <div className="flex flex-col gap-3">
        {platform === "youtube" && (
          <div>
            <label className="mb-1 block text-xs text-muted">Titel</label>
            <input
              value={caption.title || ""}
              onChange={(e) => onChange({ title: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-muted">Caption</label>
            <span
              className={`text-[11px] ${
                len > p.maxChars ? "text-red-400" : "text-muted"
              }`}
            >
              {len}/{p.maxChars}
            </span>
          </div>
          <textarea
            value={caption.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            rows={5}
            className="w-full resize-none rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted">
            Story-overlay (korte tekst)
          </label>
          <input
            value={caption.story}
            onChange={(e) => onChange({ story: e.target.value })}
            maxLength={70}
            className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted">Hashtags</label>
          <div className="flex flex-wrap gap-1.5">
            {caption.hashtags.map((h, i) => (
              <span
                key={i}
                className="rounded-md bg-brand/15 px-2 py-1 text-[11px] text-brand"
              >
                #{h}
              </span>
            ))}
            {caption.hashtags.length === 0 && (
              <span className="text-[11px] text-muted">geen</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function PhonePreview({
  platform,
  media,
  caption,
  placements,
}: {
  platform: PlatformId;
  media?: MediaItem;
  caption: PlatformCaption;
  placements: PlacementId[];
}) {
  const showStory = placements.includes("story");
  const showFeed =
    placements.includes("feed") ||
    placements.includes("reel") ||
    placements.includes("short") ||
    placements.length === 0;

  return (
    <div className="flex flex-col items-center gap-4">
      {showFeed && (
        <PhoneFrame label={platform === "youtube" ? "Short / Video" : "Feed"}>
          <FeedPreview platform={platform} media={media} caption={caption} />
        </PhoneFrame>
      )}
      {showStory && (
        <PhoneFrame label="Story">
          <StoryPreview media={media} caption={caption} />
        </PhoneFrame>
      )}
      {!showFeed && !showStory && (
        <p className="text-xs text-muted">Geen plaatsing geselecteerd</p>
      )}
    </div>
  );
}

function PhoneFrame({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">
        {label}
      </span>
      <div className="relative w-[260px] overflow-hidden rounded-[2rem] border-4 border-surface-2 bg-black shadow-2xl">
        <div className="absolute left-1/2 top-1.5 z-10 h-4 w-20 -translate-x-1/2 rounded-full bg-black" />
        {children}
      </div>
    </div>
  );
}

function MediaBox({
  media,
  className,
}: {
  media?: MediaItem;
  className: string;
}) {
  if (!media)
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-surface-2 to-surface text-muted ${className}`}
      >
        <span className="text-xs">📷 jouw media</span>
      </div>
    );
  return media.type === "image" ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={media.url} alt="" className={`object-cover ${className}`} />
  ) : (
    <video
      src={media.url}
      className={`object-cover ${className}`}
      muted
      loop
      autoPlay
      playsInline
    />
  );
}

function FeedPreview({
  platform,
  media,
  caption,
}: {
  platform: PlatformId;
  media?: MediaItem;
  caption: PlatformCaption;
}) {
  const p = PLATFORM_MAP[platform];
  return (
    <div className="bg-white pt-6 text-black">
      {/* header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div
          className="h-7 w-7 rounded-full"
          style={{ background: p.gradient }}
        />
        <span className="text-xs font-semibold">jouw_account</span>
        <span className="ml-auto text-lg leading-none">⋯</span>
      </div>
      <MediaBox media={media} className="h-[260px] w-full" />
      {/* actions */}
      <div className="flex items-center gap-3 px-3 py-2 text-lg">
        <span>♥</span>
        <span>💬</span>
        <span>➦</span>
        {platform === "youtube" && (
          <span className="ml-auto text-xs font-semibold text-red-600">
            ▶ Short
          </span>
        )}
      </div>
      <div className="px-3 pb-3">
        {platform === "youtube" && caption.title && (
          <p className="mb-1 text-xs font-bold">{caption.title}</p>
        )}
        <p className="whitespace-pre-wrap text-[11px] leading-snug">
          <span className="font-semibold">jouw_account</span> {caption.caption}
        </p>
        {caption.hashtags.length > 0 && (
          <p className="mt-1 text-[11px] text-blue-600">
            {caption.hashtags.map((h) => `#${h}`).join(" ")}
          </p>
        )}
      </div>
    </div>
  );
}

function StoryPreview({
  media,
  caption,
}: {
  media?: MediaItem;
  caption: PlatformCaption;
}) {
  return (
    <div className="relative h-[420px] w-full">
      <MediaBox media={media} className="h-full w-full" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/40" />
      {/* progress bar */}
      <div className="absolute left-3 right-3 top-3 flex gap-1">
        <span className="h-0.5 flex-1 rounded bg-white/90" />
        <span className="h-0.5 flex-1 rounded bg-white/40" />
      </div>
      <div className="absolute left-3 top-6 flex items-center gap-2">
        <div className="h-6 w-6 rounded-full bg-white/90" />
        <span className="text-[11px] font-semibold text-white drop-shadow">
          jouw_account
        </span>
      </div>
      {/* overlay text */}
      <div className="absolute inset-x-0 bottom-20 px-4 text-center">
        <span className="inline-block rounded-md bg-black/40 px-3 py-1.5 text-sm font-bold text-white backdrop-blur-sm">
          {caption.story}
        </span>
      </div>
      <div className="absolute inset-x-4 bottom-6 flex items-center gap-2">
        <div className="flex-1 rounded-full border border-white/60 px-3 py-1.5 text-[11px] text-white/80">
          Reageer…
        </div>
        <span className="text-lg text-white">♥</span>
        <span className="text-lg text-white">➤</span>
      </div>
    </div>
  );
}
