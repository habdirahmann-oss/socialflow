"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PLATFORMS,
  PLATFORM_MAP,
  TONES,
  type PlacementId,
  type PlatformId,
} from "@/lib/platforms";
import type {
  CaptionRequest,
  CaptionResponse,
  CaptionResult,
  MediaKind,
  PlacementsByPlatform,
  PlatformCaption,
} from "@/lib/types";
import type { PostView } from "@/lib/post-view";
import { channelBlockReason, countTargets, normalizeTargets } from "@/lib/targets";
import { postJson } from "@/lib/client-fetch";
import {
  ACCEPT,
  prepareMedia,
  uploadMedia,
  type PreparedMedia,
} from "@/lib/upload-client";
import {
  LS_ACCOUNT_KEY,
  CHANNEL_ORDER,
  channelHandle,
  connectedChannels,
  formatWhen,
  healthWarnings,
  isConnected,
  localDateTimeMin,
  placementName,
  previewName,
  targetList,
  targetsFromResults,
  type AccountInfo,
  type MediaItem,
  type PublishResponse,
} from "./_components/composer-lib";
import {
  Card,
  EmptyState,
  Header,
  MiniPost,
  PlatformBadge,
  SegBtn,
  Spinner,
  Switch,
  historyTime,
} from "./_components/ui";
import { CaptionEditor, PhonePreview } from "./_components/previews";
import { ConfirmModal, type ModalMode, type ModalState } from "./_components/ConfirmModal";
import { ResultPanel, type ResultPanelState } from "./_components/ResultPanel";

/** YouTube Shorts: max. 3 minuten. */
const YT_SHORT_MAX_S = 180;
/** Instagram Reels: max. 15 minuten. */
const IG_REEL_MAX_S = 15 * 60;

const errText = (e: unknown, fallback = "onbekende fout") =>
  e instanceof Error ? e.message : fallback;

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, "0")} min` : `${r} s`;
}

/** Wat er bij bevestigen verstuurd wordt (vastgelegd bij het openen van de modal). */
interface PostPayload {
  media: { url: string; type: MediaKind } | null;
  captions: Partial<Record<PlatformId, PlatformCaption>>;
  subject: string;
}

/* ---------------- Page ---------------- */

export default function Page() {
  const [media, setMedia] = useState<MediaItem | null>(null);
  const [subject, setSubject] = useState("");
  const [tone, setTone] = useState<string>(TONES[0]);
  const [captions, setCaptions] = useState<Partial<CaptionResult>>({});
  /** Kanalen waarvan de gebruiker de tekst zelf heeft aangepast. */
  const [edited, setEdited] = useState<Set<PlatformId>>(() => new Set());
  const [loading, setLoading] = useState(false);
  /** Kanaal waarvoor nu los gegenereerd wordt. */
  const [genFor, setGenFor] = useState<PlatformId | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<"now" | "later">("now");
  const [scheduleAt, setScheduleAt] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<PlatformId | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountId, setAccountId] = useState<string>("");
  /** Telt caption-aanvragen; een antwoord van vóór een accountwissel wordt genegeerd. */
  const captionReqRef = useRef(0);
  const [healthNow, setHealthNow] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [result, setResult] = useState<ResultPanelState | null>(null);
  const [upcoming, setUpcoming] = useState<PostView[]>([]);
  const [recent, setRecent] = useState<PostView[]>([]);
  const [overviewKey, setOverviewKey] = useState(0);
  const reloadOverview = () => setOverviewKey((k) => k + 1);

  /* ---------------- Kanalen & plaatsingen ---------------- */
  // Gekozen kanalen. Alle wijzigingen gaan via commitSelected, zodat handlers
  // (ook na een await) altijd de actuele selectie lezen via selectedRef.
  const [selected, setSelectedState] = useState<Set<PlatformId>>(() => new Set());
  const selectedRef = useRef<Set<PlatformId>>(new Set());
  const commitSelected = (next: Set<PlatformId>) => {
    selectedRef.current = next;
    setSelectedState(next);
  };
  /** Kanalen die automatisch uitgezet zijn door de media (worden teruggezet als het weer kan). */
  const autoDroppedRef = useRef<Set<PlatformId>>(new Set());
  const accountsRef = useRef<AccountInfo[]>([]);
  const accountIdRef = useRef("");
  const mediaKindRef = useRef<MediaKind | undefined>(undefined);

  // Instagram: feed/reel is één keuze die automatisch meeschakelt (video → Reel,
  // foto → Feed); Story is optioneel. YouTube: Short óf Video.
  const [igMain, setIgMain] = useState(true);
  const [igStory, setIgStory] = useState(false);
  const [ytMode, setYtMode] = useState<"short" | "video">("short");

  /* ---------------- Toast ---------------- */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string, ms = 3500) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, ms);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  /* ---------------- Account (stap 0) ---------------- */
  /**
   * Kiest een account: onthoudt het in deze browser en zet de kanalen op
   * precies de gekoppelde kanalen van dat account (min wat met de huidige
   * media niet kan).
   *
   * NB: posten naar meerdere accounts tegelijk valt bewust buiten scope —
   * captions en plaatsingen zijn per account, dus dat vraagt een eigen flow.
   */
  const selectAccount = (id: string, list: AccountInfo[] = accountsRef.current) => {
    const acc = list.find((a) => a.id === id);
    accountIdRef.current = id;
    setAccountId(id);
    setHealthNow(Date.now());
    try {
      localStorage.setItem(LS_ACCOUNT_KEY, id);
    } catch {
      // geen opslag beschikbaar (privévenster e.d.) — geen probleem
    }
    const kind = mediaKindRef.current;
    const conn = connectedChannels(acc);
    const blocked = kind ? conn.filter((p) => channelBlockReason(p, kind)) : [];
    autoDroppedRef.current = new Set(blocked);
    commitSelected(new Set(conn.filter((p) => !blocked.includes(p))));
  };

  /**
   * Wisselen via de dropdown. Captions worden per account gemaakt (merknaam,
   * toon), dus bij een wissel met bestaande captions vragen we bevestiging en
   * wissen we ze — anders gaat de tekst van klant A naar de kanalen van klant B.
   */
  const changeAccount = (id: string) => {
    if (id === accountIdRef.current) return;
    const hasAny = Object.keys(captions).length > 0;
    if (hasAny || loading || genFor) {
      const from = accountsRef.current.find((a) => a.id === accountIdRef.current)?.name || "dit account";
      const to = accountsRef.current.find((a) => a.id === id)?.name || "het andere account";
      if (
        !window.confirm(
          `De captions zijn gemaakt voor ${from}.\n\nBij wisselen naar ${to} worden ze gewist, zodat er geen tekst van de verkeerde klant geplaatst wordt. Doorgaan?`,
        )
      ) {
        return;
      }
    }
    // Lopende AI-aanvragen voor het oude account negeren.
    captionReqRef.current++;
    setLoading(false);
    setGenFor(null);
    setCaptions({});
    setEdited(new Set());
    setSource(null);
    setActivePreview(null);
    setResult(null);
    selectAccount(id);
  };

  /* load accounts + koppelingsstatus; kies ?account= → onthouden → eerste */
  useEffect(() => {
    let cancelled = false;
    postJson<{ accounts?: AccountInfo[] }>("/api/accounts", undefined, "GET")
      .then((d) => {
        if (cancelled) return;
        const list: AccountInfo[] = d.accounts || [];
        accountsRef.current = list;
        setAccounts(list);
        setAccountsLoaded(true);
        let fromUrl: string | null = null;
        try {
          fromUrl = new URLSearchParams(window.location.search).get("account");
        } catch {
          fromUrl = null;
        }
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(LS_ACCOUNT_KEY);
        } catch {
          stored = null;
        }
        const pick =
          [fromUrl, stored].find((id) => id && list.some((a) => a.id === id)) ||
          list[0]?.id;
        if (pick) selectAccount(pick, list);
      })
      .catch((e) => {
        if (cancelled) return;
        setAccountsLoaded(true);
        showToast(`Accounts laden mislukt: ${errText(e)}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentAccount = accounts.find((a) => a.id === accountId);
  const connectedCount = connectedChannels(currentAccount).length;
  const warnings = useMemo(
    () => (healthNow ? healthWarnings(currentAccount, healthNow) : []),
    [currentAccount, healthNow],
  );

  /* overzicht voor het GEKOZEN account: volgende 5 geplande + laatste 5 uit de geschiedenis */
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const q = `accountId=${encodeURIComponent(accountId)}`;
    Promise.all([
      postJson<{ posts?: PostView[] }>(`/api/schedule?${q}`, undefined, "GET"),
      postJson<{ entries?: PostView[] }>(`/api/history?${q}`, undefined, "GET"),
    ])
      .then(([s, h]) => {
        if (cancelled) return;
        const posts = s.posts || [];
        setUpcoming(
          posts
            .filter((p) => p.status === "pending" || p.status === "processing")
            .sort((a, b) => a.scheduledFor - b.scheduledFor)
            .slice(0, 5),
        );
        setRecent(
          [
            ...posts.filter((p) => p.status !== "pending" && p.status !== "processing"),
            ...(h.entries || []),
          ]
            .sort((a, b) => historyTime(b) - historyTime(a))
            .slice(0, 5),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId, overviewKey]);

  /* ---------------- Media ---------------- */
  const fileRef = useRef<HTMLInputElement>(null);
  // Huidige upload: bestand (voor 'Opnieuw'), preview-URL en afbreekknop.
  const preparedRef = useRef<PreparedMedia | null>(null);
  const previewRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pickSeq = useRef(0);

  const releaseMedia = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    preparedRef.current = null;
  };

  // opruimen bij verlaten van de pagina
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  /**
   * Nieuwe media → kanalen die er niets mee kunnen gaan automatisch uit; kanalen
   * die eerder om die reden uitgingen gaan weer aan als het nu wel kan.
   */
  const applyMediaKind = (kind: MediaKind) => {
    mediaKindRef.current = kind;
    const acc = accountsRef.current.find((a) => a.id === accountIdRef.current);
    const next = new Set(selectedRef.current);
    const removed: { p: PlatformId; reason: string }[] = [];
    const restored: PlatformId[] = [];
    for (const p of selectedRef.current) {
      const reason = channelBlockReason(p, kind);
      if (reason) {
        next.delete(p);
        autoDroppedRef.current.add(p);
        removed.push({ p, reason });
      }
    }
    for (const p of Array.from(autoDroppedRef.current)) {
      if (removed.some((r) => r.p === p)) continue;
      if (!channelBlockReason(p, kind) && isConnected(acc, p)) {
        next.add(p);
        restored.push(p);
        autoDroppedRef.current.delete(p);
      }
    }
    if (!removed.length && !restored.length) return;
    commitSelected(next);
    const parts: string[] = [];
    if (removed.length) {
      parts.push(
        `${removed.map((r) => PLATFORM_MAP[r.p].name).join(" en ")} uitgezet (${
          removed[0].reason
        })`,
      );
    }
    if (restored.length) {
      parts.push(`${restored.map((p) => PLATFORM_MAP[p].name).join(" en ")} weer aangezet`);
    }
    showToast(`${kind === "image" ? "Foto" : "Video"}: ${parts.join(" · ")}`, 5000);
  };

  const startUpload = (prepared: PreparedMedia) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setMedia((m) => (m ? { ...m, progress: 0, error: null, url: null } : m));
    uploadMedia(
      prepared,
      (pct) => {
        if (ctrl.signal.aborted) return;
        setMedia((m) => (m ? { ...m, progress: pct } : m));
      },
      ctrl.signal,
    )
      .then((url) => {
        if (ctrl.signal.aborted) return;
        setMedia((m) => (m ? { ...m, url, progress: 100, error: null } : m));
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setMedia((m) =>
          m ? { ...m, url: null, error: errText(e, "Upload mislukt") } : m,
        );
      });
  };

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const seq = ++pickSeq.current;
    let prepared: PreparedMedia;
    try {
      prepared = await prepareMedia(file);
    } catch (e) {
      if (seq !== pickSeq.current) return;
      showToast(errText(e, "Bestand niet bruikbaar"));
      return;
    }
    if (seq !== pickSeq.current) {
      URL.revokeObjectURL(prepared.previewUrl);
      return;
    }
    // Nieuwe keuze vervangt de vorige (één media-item per post).
    releaseMedia();
    preparedRef.current = prepared;
    previewRef.current = prepared.previewUrl;
    setMedia({
      previewUrl: prepared.previewUrl,
      url: null,
      type: prepared.type,
      mime: prepared.mime,
      name: file.name,
      width: prepared.width,
      height: prepared.height,
      duration: prepared.duration,
      progress: 0,
      error: null,
    });
    applyMediaKind(prepared.type);
    startUpload(prepared);
  };

  const retryUpload = () => {
    if (preparedRef.current) startUpload(preparedRef.current);
  };

  const removeMedia = () => {
    pickSeq.current++;
    releaseMedia();
    mediaKindRef.current = undefined;
    setMedia(null);
  };

  const mediaUploading = Boolean(media && !media.url && !media.error);
  const mediaFailed = Boolean(media?.error);
  const mediaKind = media?.type;

  /* ---------------- Platforms ---------------- */
  /** Reden waarom een kanaal met de huidige media niet kan (alleen als er media is). */
  const hardBlock = (id: PlatformId) => (mediaKind ? channelBlockReason(id, mediaKind) : null);

  const togglePlatform = (id: PlatformId) => {
    if (!isConnected(currentAccount, id) || hardBlock(id)) return;
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    autoDroppedRef.current.delete(id);
    commitSelected(next);
  };

  const selectedList = useMemo(
    () => PLATFORMS.filter((p) => selected.has(p.id)),
    [selected],
  );

  // Preview-tab volgt de selectie zonder effect: valt terug op het eerste gekozen kanaal.
  const previewId: PlatformId | undefined =
    activePreview && selected.has(activePreview) ? activePreview : selectedList[0]?.id;

  /** Ruwe plaatsingen uit de UI-keuzes. */
  const rawTargets = (): PlacementsByPlatform => {
    const raw: PlacementsByPlatform = {};
    const sel = selected;
    if (sel.has("facebook")) raw.facebook = ["feed"];
    if (sel.has("tiktok")) raw.tiktok = ["feed"];
    if (sel.has("youtube")) raw.youtube = [ytMode];
    if (sel.has("instagram")) {
      const ig: PlacementId[] = [];
      if (igMain) ig.push(mediaKind === "video" ? "reel" : "feed");
      if (igStory) ig.push("story");
      raw.instagram = ig;
    }
    return raw;
  };
  /** Targets voor de API — altijd via normalizeTargets (T4). */
  const buildTargets = () => normalizeTargets(rawTargets(), mediaKind);
  const built = buildTargets();

  const igPlacementLabel =
    mediaKind === "video" ? "Reel" : mediaKind === "image" ? "Feed" : "Feed / Reel";

  /* ---------------- AI captions ---------------- */
  /** Vraagt captions aan voor `platforms`, met media-soort en plaatsingen (Reel/Short …). */
  const requestCaptions = (platforms: PlatformId[]) => {
    const raw = rawTargets();
    const placements: PlacementsByPlatform = {};
    for (const p of platforms) if (raw[p]) placements[p] = raw[p];
    const body: CaptionRequest = {
      subject,
      tone,
      platforms,
      mediaType: mediaKind,
      placements,
      accountName: currentAccount?.name,
    };
    return postJson<CaptionResponse>("/api/captions", body);
  };

  const sourceToast = (src?: string) =>
    showToast(
      src === "claude"
        ? "Captions gegenereerd met Claude ✨"
        : "Captions gegenereerd (lokaal) — voeg een API-key toe voor slimmere teksten",
    );

  const generate = async () => {
    if (selected.size === 0) {
      showToast("Kies eerst minstens één kanaal");
      return;
    }
    const platforms = selectedList.map((p) => p.id);
    if (
      platforms.some((p) => edited.has(p)) &&
      !window.confirm("Je bewerkte captions worden overschreven. Doorgaan?")
    ) {
      return;
    }
    setLoading(true);
    setSource(null);
    const req = ++captionReqRef.current;
    try {
      const data = await requestCaptions(platforms);
      // Intussen van account gewisseld → resultaat hoort bij het oude account.
      if (req !== captionReqRef.current) return;
      if (data.result) {
        const res = data.result;
        setCaptions((c) => ({ ...c, ...res }));
        setEdited((e) => {
          const next = new Set(e);
          for (const p of Object.keys(res) as PlatformId[]) next.delete(p);
          return next;
        });
        setSource(data.source ?? null);
        sourceToast(data.source);
      } else {
        showToast(data.error || "Genereren mislukt");
      }
    } catch (e) {
      if (req === captionReqRef.current) showToast(errText(e, "Genereren mislukt"));
    } finally {
      if (req === captionReqRef.current) setLoading(false);
    }
  };

  /** Alleen dit kanaal (bv. later aangezet) — de andere kanalen blijven onaangeroerd. */
  const generateFor = async (pid: PlatformId) => {
    if (genFor || loading) return;
    setGenFor(pid);
    const req = ++captionReqRef.current;
    try {
      const data = await requestCaptions([pid]);
      if (req !== captionReqRef.current) return;
      const c = data.result?.[pid];
      if (c) {
        setCaptions((prev) => ({ ...prev, [pid]: c }));
        setEdited((e) => {
          if (!e.has(pid)) return e;
          const next = new Set(e);
          next.delete(pid);
          return next;
        });
        if (data.source) setSource(data.source);
        showToast(`Caption voor ${PLATFORM_MAP[pid].name} gegenereerd`);
      } else {
        showToast(data.error || "Genereren mislukt");
      }
    } catch (e) {
      if (req === captionReqRef.current) showToast(errText(e, "Genereren mislukt"));
    } finally {
      if (req === captionReqRef.current) setGenFor(null);
    }
  };

  const updateCaption = (pid: PlatformId, patch: Partial<PlatformCaption>) => {
    setCaptions((c) => {
      const cur = c[pid];
      return cur ? { ...c, [pid]: { ...cur, ...patch } } : c;
    });
    setEdited((e) => (e.has(pid) ? e : new Set(e).add(pid)));
  };

  /* ---------------- Publish-voorwaarden ---------------- */
  const isLater = schedule === "later";
  const missing: string[] = [];
  if (!accountId) missing.push("kies een account");
  if (selected.size === 0) missing.push("kies minstens één kanaal");
  for (const p of selectedList) {
    const reason = channelBlockReason(p.id, mediaKind);
    if (reason) missing.push(`${p.name}: ${reason}`);
  }
  if (selected.has("instagram") && !igMain && !igStory) {
    missing.push("Instagram: kies een plaatsing");
  }
  const noCaption = selectedList.filter((p) => !captions[p.id]?.caption?.trim());
  if (noCaption.length) {
    missing.push(`caption voor ${noCaption.map((p) => p.name).join(", ")}`);
  }
  if (mediaUploading) missing.push(`upload loopt nog (${media?.progress ?? 0}%)`);
  if (mediaFailed) missing.push("upload mislukt — klik op 'Opnieuw'");
  if (isLater && !scheduleAt) missing.push("kies datum en tijd");
  const canPublish = missing.length === 0;

  const buildCaptions = (): PostPayload["captions"] => {
    const out: PostPayload["captions"] = {};
    for (const p of CHANNEL_ORDER) {
      if (selected.has(p) && captions[p]) out[p] = captions[p];
    }
    return out;
  };
  // Alleen de publieke URL gaat mee (de upload is al klaar) → kleine JSON-body.
  const mediaPayload = (): PostPayload["media"] =>
    media?.url ? { url: media.url, type: media.type } : null;

  /* ---------------- Bevestigingsmodal + automatische dry-run ---------------- */
  const payloadRef = useRef<PostPayload | null>(null);
  const dryRunSeq = useRef(0);

  const runDryRun = async (st: Pick<ModalState, "accountId" | "targets">) => {
    const seq = ++dryRunSeq.current;
    const payload = payloadRef.current;
    setModal((m) =>
      m ? { ...m, phase: "checking", dry: undefined, error: undefined, submitError: undefined } : m,
    );
    try {
      const data = await postJson<PublishResponse>("/api/publish", {
        accountId: st.accountId,
        media: payload?.media ?? null,
        targets: st.targets,
        captions: payload?.captions ?? {},
        subject: payload?.subject ?? "",
        dryRun: true, // altijd: deze controle plaatst nooit iets
      });
      if (seq !== dryRunSeq.current) return;
      setModal((m) =>
        m
          ? {
              ...m,
              phase: "ready",
              dry: { results: data.results || [], dropped: data.dropped || [] },
            }
          : m,
      );
    } catch (e) {
      if (seq !== dryRunSeq.current) return;
      setModal((m) => (m ? { ...m, phase: "error", error: errText(e) } : m));
    }
  };

  const openConfirm = () => {
    if (!canPublish || publishing || modal) return;
    const mode: ModalMode = isLater ? "schedule" : dryRun ? "test" : "now";
    let scheduledFor: number | undefined;
    if (mode === "schedule") {
      const ts = new Date(scheduleAt).getTime();
      if (isNaN(ts)) {
        showToast("Ongeldige datum/tijd");
        return;
      }
      if (ts < Date.now() - 60_000) {
        showToast("Kies een tijdstip in de toekomst");
        return;
      }
      scheduledFor = ts;
    }
    const { targets, dropped } = buildTargets();
    payloadRef.current = { media: mediaPayload(), captions: buildCaptions(), subject };
    const st: ModalState = {
      mode,
      accountId,
      accountName: currentAccount?.name ?? "account",
      targets,
      clientDropped: dropped,
      scheduledFor,
      // client-id → dubbel klikken / opnieuw versturen maakt geen tweede post (T2)
      scheduleId: mode === "schedule" ? crypto.randomUUID() : undefined,
      phase: "checking",
    };
    setModal(st);
    void runDryRun(st);
  };

  const closeModal = useCallback(() => {
    dryRunSeq.current++; // late dry-run-antwoorden negeren
    setModal((m) => (m && m.phase === "submitting" ? m : null));
  }, []);

  const confirmModal = async () => {
    const st = modal;
    if (!st || st.mode === "test" || st.phase !== "ready" || !st.dry) return;
    const passing = targetsFromResults(st.dry.results);
    if (countTargets(passing) === 0) return;
    const payload = payloadRef.current ?? { media: null, captions: {}, subject: "" };
    setModal({ ...st, phase: "submitting", submitError: undefined });

    /* ---------- Inplannen (alleen geslaagde targets) ---------- */
    if (st.mode === "schedule") {
      try {
        const data = await postJson<{ ok?: boolean; error?: string }>("/api/schedule", {
          id: st.scheduleId,
          accountId: st.accountId,
          accountName: st.accountName,
          scheduledFor: st.scheduledFor,
          media: payload.media,
          subject: payload.subject,
          targets: passing,
          captions: payload.captions,
        });
        if (data.ok) {
          setModal(null);
          showToast(
            `Ingepland voor ${formatWhen(st.scheduledFor!)} — wordt meestal binnen ~5–15 minuten na dat tijdstip geplaatst`,
            5000,
          );
          reloadOverview();
        } else {
          setModal((m) =>
            m ? { ...m, phase: "ready", submitError: data.error || "Inplannen mislukt" } : m,
          );
        }
      } catch (e) {
        setModal((m) =>
          m ? { ...m, phase: "ready", submitError: `Inplannen mislukt: ${errText(e)}` } : m,
        );
      }
      return;
    }

    /* ---------- Echt posten (alleen geslaagde targets) ---------- */
    setPublishing(true);
    let panel: ResultPanelState;
    try {
      const data = await postJson<PublishResponse>("/api/publish", {
        accountId: st.accountId,
        media: payload.media,
        targets: passing,
        captions: payload.captions,
        subject: payload.subject,
        dryRun: false,
      });
      const results = data.results || [];
      panel = {
        accountId: st.accountId,
        accountName: st.accountName,
        historyId: data.historyId,
        results,
        dropped: data.dropped || [],
        error: results.length ? undefined : data.error || "Geen plaatsingen verstuurd",
      };
    } catch (e) {
      panel = {
        accountId: st.accountId,
        accountName: st.accountName,
        results: [],
        dropped: [],
        error: `Posten mislukt: ${errText(e)}. Controleer in Planning wat al geplaatst is voordat je opnieuw post.`,
      };
    }
    setPublishing(false);
    setModal(null);
    setResult(panel);
    // Echte posts staan server-side in de geschiedenis (ook bij een time-out).
    reloadOverview();
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ---------------- Resultaatpaneel ---------------- */
  const retryFailed = async () => {
    const id = result?.historyId;
    if (!id || result?.retrying) return;
    setResult((r) => (r ? { ...r, retrying: true, retryError: undefined } : r));
    try {
      const data = await postJson<{ ok?: boolean; post?: PostView; error?: string }>(
        "/api/history/retry",
        { id },
      );
      setResult((r) =>
        r
          ? {
              ...r,
              retrying: false,
              results: data.post?.results ?? r.results,
              error: undefined,
            }
          : r,
      );
    } catch (e) {
      setResult((r) =>
        r ? { ...r, retrying: false, retryError: `Opnieuw proberen mislukt: ${errText(e)}` } : r,
      );
    }
    reloadOverview();
  };

  const newPost = () => {
    removeMedia();
    setCaptions({});
    setEdited(new Set());
    setSubject("");
    setSource(null);
    setIgMain(true);
    setIgStory(false);
    setYtMode("short");
    setScheduleAt("");
    setActivePreview(null);
    setResult(null);
    // kanalen terug naar de gekoppelde kanalen van het account
    if (accountIdRef.current) selectAccount(accountIdRef.current);
  };

  const cancelScheduled = async (p: PostView) => {
    if (!window.confirm(`Geplande post annuleren?\n\n"${p.subject}"`)) return;
    setUpcoming((s) => s.filter((x) => x.id !== p.id));
    try {
      await postJson(`/api/schedule?id=${encodeURIComponent(p.id)}`, undefined, "DELETE");
    } catch (e) {
      showToast(`Annuleren mislukt: ${errText(e)}`);
    }
    reloadOverview();
  };

  const activeCaption = previewId ? captions[previewId] : undefined;
  const hasCaptions = Object.keys(captions).length > 0;

  /* Waarschuwingen per plaatsing (duur/afmetingen uit de upload, T3) */
  const ytWarnings: string[] = [];
  if (mediaKind === "video" && ytMode === "short" && media) {
    if (media.duration && media.duration > YT_SHORT_MAX_S) {
      ytWarnings.push(
        `Deze video is ${fmtDuration(media.duration)} — Shorts mogen max. 3 min zijn. Kies 'Video'.`,
      );
    }
    if (media.width && media.height && media.width >= media.height) {
      ytWarnings.push(
        "Deze video is niet verticaal — een Short hoort 9:16 te zijn, anders toont YouTube 'm als gewone video.",
      );
    }
  }
  const igWarnings: string[] = [];
  if (mediaKind === "video" && igMain && media?.duration && media.duration > IG_REEL_MAX_S) {
    igWarnings.push(
      `Deze video is ${fmtDuration(media.duration)} — Instagram Reels mogen max. 15 min zijn.`,
    );
  }

  const publishLabel = isLater ? "🗓️ Plan in" : dryRun ? "🧪 Test (dry-run)" : "🚀 Post nu";

  /* ---------------- Render ---------------- */
  return (
    <div className="min-h-screen">
      <Header connected={connectedCount} accountName={currentAccount?.name} />

      <main className="mx-auto max-w-7xl px-4 pb-24 pt-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr]">
          {/* LEFT — composer */}
          <div className="flex flex-col gap-5">
            {/* 0. account */}
            <Card step={0} title="Voor welk account?">
              {/* Eén account per post; multi-account posten valt buiten scope (captions/targets zijn per account). */}
              <select
                value={accountId}
                onChange={(e) => changeAccount(e.target.value)}
                disabled={!accountsLoaded || accounts.length === 0}
                aria-label="Account"
                className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2.5 text-sm font-semibold outline-none focus:border-brand disabled:opacity-60"
              >
                {!accountsLoaded && <option value="">Accounts laden…</option>}
                {accountsLoaded && accounts.length === 0 && (
                  <option value="">Nog geen accounts</option>
                )}
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>

              {currentAccount && (
                <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {CHANNEL_ORDER.map((pid) => {
                    const ok = isConnected(currentAccount, pid);
                    const handle = channelHandle(currentAccount, pid);
                    return (
                      <li
                        key={pid}
                        className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${
                          ok
                            ? "border-accent/30 bg-accent/5"
                            : "border-border bg-surface-2/30 text-muted"
                        }`}
                      >
                        <span className={ok ? "" : "opacity-40 grayscale"}>
                          <PlatformBadge id={pid} small />
                        </span>
                        <span className="min-w-0 truncate">
                          {ok ? (
                            <span className="text-foreground">{handle || PLATFORM_MAP[pid].name}</span>
                          ) : (
                            <>
                              {PLATFORM_MAP[pid].name} · niet gekoppeld
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {currentAccount && (
                <a
                  href={`/verbindingen?account=${encodeURIComponent(currentAccount.id)}`}
                  className="mt-2 inline-block text-[11px] text-brand underline-offset-2 hover:underline"
                >
                  Koppelingen beheren →
                </a>
              )}

              {warnings.length > 0 && (
                <div
                  role="alert"
                  className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
                >
                  <p className="font-semibold text-amber-300">⚠️ Koppeling vraagt aandacht</p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {warnings.map((w, i) => (
                      <li key={`${w.platform}-${i}`}>{w.text}</li>
                    ))}
                  </ul>
                  <a
                    href={`/verbindingen?account=${encodeURIComponent(accountId)}`}
                    className="mt-1 inline-block underline"
                  >
                    Opnieuw koppelen via Verbindingen
                  </a>
                </div>
              )}
            </Card>

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
                  {media
                    ? "Sleep een ander bestand hierheen om te vervangen"
                    : "Sleep een foto of video hierheen"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  of klik om te kiezen · JPG, PNG, MP4 of MOV (max 500 MB)
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPT}
                  hidden
                  onChange={(e) => {
                    onFiles(e.target.files);
                    // zelfde bestand opnieuw kiezen moet ook werken
                    e.target.value = "";
                  }}
                />
              </div>

              {media && (
                <div className="mt-3 flex items-start gap-3">
                  <div className="group relative aspect-square w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-black">
                    {media.type === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={media.previewUrl}
                        alt={media.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <video
                        src={media.previewUrl}
                        className="h-full w-full object-cover"
                        muted
                        playsInline
                        controls
                      />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeMedia();
                      }}
                      title="Verwijderen"
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white opacity-80 transition group-hover:opacity-100"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{media.name}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {media.type === "image" ? "Foto (JPEG)" : "Video"}
                      {media.width && media.height
                        ? ` · ${media.width}×${media.height}`
                        : ""}
                      {media.duration ? ` · ${fmtDuration(media.duration)}` : ""}
                    </p>
                    {media.error ? (
                      <div className="mt-2">
                        <p className="text-[11px] text-red-400">{media.error}</p>
                        <button
                          onClick={retryUpload}
                          className="mt-1.5 rounded-md border border-border bg-surface-2/60 px-2.5 py-1 text-[11px] transition hover:border-brand"
                        >
                          Opnieuw
                        </button>
                      </div>
                    ) : media.url ? (
                      <p className="mt-2 text-[11px] text-accent">✓ Geüpload</p>
                    ) : (
                      <div className="mt-2">
                        <p className="text-[11px] text-muted">Uploaden… {media.progress}%</p>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full bg-brand transition-[width]"
                            style={{ width: `${media.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
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
                  const connected = isConnected(currentAccount, p.id);
                  const blocked = connected ? hardBlock(p.id) : null;
                  const softReason = connected ? channelBlockReason(p.id, mediaKind) : null;
                  const disabled = !connected || Boolean(blocked);
                  const on = selected.has(p.id) && !disabled;
                  const handle = channelHandle(currentAccount, p.id);
                  return (
                    <div
                      key={p.id}
                      className={`rounded-xl border p-3 transition ${
                        on
                          ? "border-border bg-surface-2/60"
                          : disabled
                            ? "border-border/40 bg-transparent"
                            : "border-border/50 bg-transparent opacity-70"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => togglePlatform(p.id)}
                          disabled={disabled}
                          className={`flex min-w-0 items-center gap-3 ${
                            disabled ? "cursor-not-allowed" : ""
                          }`}
                        >
                          <span className={disabled ? "opacity-40 grayscale" : ""}>
                            <PlatformBadge id={p.id} />
                          </span>
                          <div className="min-w-0 text-left">
                            <p
                              className={`text-sm font-semibold ${disabled ? "text-muted" : ""}`}
                            >
                              {p.name}
                            </p>
                            <p className="truncate text-xs text-muted">
                              {connected ? handle || p.blurb : p.blurb}
                            </p>
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-2">
                          {!connected && (
                            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">
                              Niet gekoppeld
                            </span>
                          )}
                          {blocked && (
                            <span className="rounded-full border border-border bg-surface-2/60 px-2 py-0.5 text-[10px] text-muted">
                              {blocked}
                            </span>
                          )}
                          <Switch
                            on={on}
                            disabled={disabled}
                            label={`${p.name} ${on ? "uitzetten" : "aanzetten"}`}
                            onClick={() => togglePlatform(p.id)}
                          />
                        </div>
                      </div>

                      {!connected && accountId && (
                        <a
                          href={`/verbindingen?account=${encodeURIComponent(accountId)}`}
                          className="mt-2 inline-block pl-1 text-[11px] text-brand underline-offset-2 hover:underline"
                        >
                          Koppel {p.name} voor dit account →
                        </a>
                      )}

                      {on && !blocked && softReason && (
                        <p className="mt-2 pl-1 text-[11px] text-amber-400">
                          {p.name} {softReason} — upload eerst je media
                        </p>
                      )}

                      {on && (
                        <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-1">
                          {p.id === "instagram" && (
                            <>
                              <PlacementChip
                                active={igMain}
                                onClick={() => {
                                  if (igMain && !igStory) return; // minstens één plaatsing
                                  setIgMain(!igMain);
                                }}
                              >
                                {igPlacementLabel}
                                {!mediaKind && " (automatisch)"}
                              </PlacementChip>
                              <PlacementChip
                                active={igStory}
                                onClick={() => {
                                  if (igStory && !igMain) return;
                                  setIgStory(!igStory);
                                }}
                              >
                                Story
                              </PlacementChip>
                              <span className="text-[10px] text-muted">
                                video → Reel · foto → Feed
                              </span>
                            </>
                          )}
                          {p.id === "youtube" && (
                            <div role="radiogroup" aria-label="YouTube-plaatsing" className="flex gap-1.5">
                              {(["short", "video"] as const).map((m) => (
                                <PlacementChip
                                  key={m}
                                  radio
                                  active={ytMode === m}
                                  onClick={() => setYtMode(m)}
                                >
                                  {m === "short" ? "Short" : "Video"}
                                </PlacementChip>
                              ))}
                            </div>
                          )}
                          {p.id === "facebook" && <PlacementChip active>Post</PlacementChip>}
                          {p.id === "tiktok" && <PlacementChip active>Video</PlacementChip>}
                        </div>
                      )}

                      {on && p.id === "youtube" &&
                        ytWarnings.map((w) => (
                          <p key={w} className="mt-2 pl-1 text-[11px] text-amber-400">
                            ⚠️ {w}
                          </p>
                        ))}
                      {on && p.id === "instagram" &&
                        igWarnings.map((w) => (
                          <p key={w} className="mt-2 pl-1 text-[11px] text-amber-400">
                            ⚠️ {w}
                          </p>
                        ))}
                    </div>
                  );
                })}
                {currentAccount && connectedCount === 0 && (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300/90">
                    ⚠️ {currentAccount.name} heeft nog geen gekoppelde kanalen.{" "}
                    <a
                      href={`/verbindingen?account=${encodeURIComponent(currentAccount.id)}`}
                      className="underline"
                    >
                      Koppel ze via Verbindingen
                    </a>
                    .
                  </p>
                )}
              </div>
            </Card>

            {/* generate button */}
            <button
              onClick={generate}
              disabled={loading || Boolean(genFor) || selected.size === 0}
              className="group relative overflow-hidden rounded-xl bg-gradient-to-r from-brand to-brand-2 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-brand/20 transition hover:brightness-110 disabled:opacity-60"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner /> AI schrijft je captions…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  {hasCaptions ? "🔄 Opnieuw genereren" : "✨ Genereer captions met AI"}
                </span>
              )}
            </button>
          </div>

          {/* RIGHT — resultaat, previews, publiceren */}
          <div className="flex flex-col gap-5">
            {result && (
              <ResultPanel state={result} onRetry={retryFailed} onNewPost={newPost} />
            )}

            {!hasCaptions ? (
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
                        previewId === p.id
                          ? "border-brand bg-brand/15"
                          : "border-border bg-surface text-muted hover:text-foreground"
                      }`}
                    >
                      <PlatformBadge id={p.id} small />
                      {p.name}
                      {!captions[p.id]?.caption && <span className="text-amber-400">•</span>}
                    </button>
                  ))}
                  {source && (
                    <span className="ml-auto rounded-full border border-border px-2.5 py-1 text-[11px] text-muted">
                      bron: {source === "claude" ? "Claude AI" : "lokaal"}
                    </span>
                  )}
                </div>

                {previewId && activeCaption ? (
                  <div className="grid grid-cols-1 gap-5 xl:grid-cols-[300px_1fr]">
                    <div className="flex flex-col items-center gap-3">
                      <PhonePreview
                        platform={previewId}
                        media={media ?? undefined}
                        caption={activeCaption}
                        placements={built.targets[previewId] || []}
                        handle={previewName(currentAccount, previewId)}
                      />
                    </div>
                    <CaptionEditor
                      key={previewId}
                      platform={previewId}
                      caption={activeCaption}
                      onChange={(patch) => updateCaption(previewId, patch)}
                    />
                  </div>
                ) : previewId ? (
                  <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                    <p>Nog geen caption voor {PLATFORM_MAP[previewId].name}.</p>
                    <button
                      type="button"
                      onClick={() => void generateFor(previewId)}
                      disabled={Boolean(genFor) || loading}
                      className="rounded-lg bg-gradient-to-r from-brand to-brand-2 px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                    >
                      {genFor === previewId ? (
                        <span className="flex items-center gap-2">
                          <Spinner /> Bezig…
                        </span>
                      ) : (
                        "Genereer voor dit kanaal"
                      )}
                    </button>
                    <p className="text-[11px]">De andere kanalen blijven zoals ze zijn.</p>
                  </div>
                ) : null}
              </>
            )}

            {/* publiceren */}
            {accountId && (
              <Card title="Publiceren">
                <div className="flex flex-col gap-4">
                  <div className="flex gap-2">
                    <SegBtn active={schedule === "now"} onClick={() => setSchedule("now")}>
                      🚀 Nu posten
                    </SegBtn>
                    <SegBtn active={schedule === "later"} onClick={() => setSchedule("later")}>
                      🗓️ Inplannen
                    </SegBtn>
                  </div>
                  {isLater && (
                    <input
                      type="datetime-local"
                      min={localDateTimeMin()}
                      value={scheduleAt}
                      onChange={(e) => setScheduleAt(e.target.value)}
                      className="rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  )}
                  {!isLater && (
                    <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                      <span className="flex items-center gap-2 text-xs">
                        🧪 Testmodus
                        <span className="text-muted">(controleer koppeling, post niets)</span>
                      </span>
                      <Switch on={dryRun} label="Testmodus" onClick={() => setDryRun(!dryRun)} />
                    </div>
                  )}

                  {countTargets(built.targets) > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {targetList(built.targets).map(({ platform, placement }) => (
                        <span
                          key={`${platform}-${placement}`}
                          className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2/40 py-0.5 pl-0.5 pr-2 text-[11px]"
                        >
                          <PlatformBadge id={platform} small />
                          {placementName(platform, placement)}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 text-xs text-muted">
                      Account:{" "}
                      <span className="font-semibold text-foreground">
                        {currentAccount?.name ?? "—"}
                      </span>
                    </p>
                    <button
                      onClick={openConfirm}
                      disabled={!canPublish || publishing || Boolean(modal)}
                      className="shrink-0 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {publishing ? (
                        <span className="flex items-center gap-2">
                          <Spinner /> Bezig…
                        </span>
                      ) : mediaUploading ? (
                        `Uploaden… ${media?.progress ?? 0}%`
                      ) : (
                        publishLabel
                      )}
                    </button>
                  </div>
                  {!canPublish && (
                    <p className="truncate text-[11px] text-amber-300/90" title={missing.join(" · ")}>
                      Nog nodig: {missing.join(" · ")}
                    </p>
                  )}
                  {canPublish && (
                    <p className="text-[11px] text-muted">
                      Je krijgt eerst een controle (dry-run) te zien
                      {dryRun && !isLater ? " — in Testmodus wordt niets geplaatst" : ""}.
                    </p>
                  )}
                </div>
              </Card>
            )}

            {/* overzicht van het gekozen account */}
            {accountId && (
              <Card title={`Planning · ${currentAccount?.name ?? "account"}`}>
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Volgende geplande posts
                    </p>
                    {upcoming.length === 0 ? (
                      <p className="text-xs text-muted">Niets ingepland.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {upcoming.map((p) => (
                          <MiniPost
                            key={p.id}
                            post={p}
                            time={p.scheduledFor}
                            onCancel={
                              p.status === "pending" ? () => cancelScheduled(p) : undefined
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Laatst geplaatst
                    </p>
                    {recent.length === 0 ? (
                      <p className="text-xs text-muted">Nog niets geplaatst.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {recent.map((p) => (
                          <MiniPost key={`${p.source}-${p.id}`} post={p} time={historyTime(p)} />
                        ))}
                      </div>
                    )}
                  </div>
                  <a
                    href={`/planning?account=${encodeURIComponent(accountId)}`}
                    className="text-xs text-brand underline-offset-2 hover:underline"
                  >
                    Alles bekijken in Planning →
                  </a>
                </div>
              </Card>
            )}
          </div>
        </div>
      </main>

      {modal && (
        <ConfirmModal
          state={modal}
          onConfirm={confirmModal}
          onClose={closeModal}
          onRecheck={() => void runDryRun(modal)}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/* ---------------- Kleine onderdelen ---------------- */

function PlacementChip({
  children,
  active,
  onClick,
  radio,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick?: () => void;
  radio?: boolean;
}) {
  const cls = `rounded-md border px-2.5 py-1 text-[11px] transition ${
    active
      ? "border-accent/60 bg-accent/15 text-accent"
      : "border-border bg-surface-2/40 text-muted hover:text-foreground"
  }`;
  if (!onClick) return <span className={cls}>{children}</span>;
  return (
    <button
      type="button"
      role={radio ? "radio" : undefined}
      aria-checked={radio ? active : undefined}
      aria-pressed={radio ? undefined : active}
      onClick={onClick}
      className={cls}
    >
      {radio ? (active ? "● " : "○ ") : active ? "✓ " : ""}
      {children}
    </button>
  );
}
