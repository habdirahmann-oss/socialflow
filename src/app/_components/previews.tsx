import { useState } from "react";
import { PLATFORM_MAP, type PlatformId, type PlacementId } from "@/lib/platforms";
import { fullText } from "@/lib/targets";
import type { PlatformCaption } from "@/lib/types";
import type { MediaItem } from "./composer-lib";
import { Card } from "./ui";

/** Max. lengte van een YouTube-titel. */
export const YT_TITLE_MAX = 100;

/** Uitleg bij de story-overlay: die tekst gaat (nog) niet mee naar Instagram. */
export const STORY_PREVIEW_NOTE = "Alleen preview — tekst wordt (nog) niet op de story geplaatst";

/** Losse hashtags uit invoer: splitst op komma's, haalt '#' en spaties weg. */
export function parseHashtags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.replace(/[#\s]+/g, ""))
    .filter(Boolean);
}

/** Voegt tags toe zonder dubbelen (hoofdletterongevoelig). */
export function addHashtags(current: string[], extra: string[]): string[] {
  const out = [...current];
  const seen = new Set(current.map((h) => h.toLowerCase()));
  for (const t of extra) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function CaptionEditor({
  platform,
  caption,
  onChange,
}: {
  platform: PlatformId;
  caption: PlatformCaption;
  onChange: (patch: Partial<PlatformCaption>) => void;
}) {
  const p = PLATFORM_MAP[platform];
  const [tagInput, setTagInput] = useState("");
  const len = fullText(caption).length;
  const over = len > p.maxChars;
  const title = caption.title || "";

  const commitTags = (raw: string) => {
    const tags = parseHashtags(raw);
    if (tags.length) onChange({ hashtags: addHashtags(caption.hashtags, tags) });
    setTagInput("");
  };
  const removeTag = (i: number) =>
    onChange({ hashtags: caption.hashtags.filter((_, j) => j !== i) });

  return (
    <Card title={`Tekst voor ${p.name}`}>
      <div className="flex flex-col gap-3">
        {platform === "youtube" && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="yt-title" className="text-xs text-muted">
                Titel
              </label>
              <span
                className={`text-[11px] ${
                  title.length > YT_TITLE_MAX ? "text-red-600" : "text-muted"
                }`}
              >
                {title.length}/{YT_TITLE_MAX}
              </span>
            </div>
            <input
              id="yt-title"
              value={title}
              maxLength={YT_TITLE_MAX}
              onChange={(e) => onChange({ title: e.target.value.slice(0, YT_TITLE_MAX) })}
              className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="caption-text" className="text-xs text-muted">
              Caption
            </label>
            <span
              title="Caption + hashtags samen"
              data-testid="caption-counter"
              className={`text-[11px] ${over ? "font-semibold text-red-600" : "text-muted"}`}
            >
              {len}/{p.maxChars}
              <span className="ml-1 opacity-70">incl. hashtags</span>
            </span>
          </div>
          <textarea
            id="caption-text"
            value={caption.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            rows={5}
            className={`w-full resize-none rounded-lg border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand ${
              over ? "border-red-500/60" : "border-border"
            }`}
          />
        </div>
        <div>
          <label htmlFor="story-text" className="block text-xs text-muted">
            Story-overlay (korte tekst)
          </label>
          <p className="mb-1 text-[10px] text-amber-700">{STORY_PREVIEW_NOTE}</p>
          <input
            id="story-text"
            value={caption.story}
            onChange={(e) => onChange({ story: e.target.value })}
            maxLength={70}
            className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div>
          <label htmlFor="tag-input" className="mb-1 block text-xs text-muted">
            Hashtags
          </label>
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-2/30 p-1.5 focus-within:border-brand">
            {caption.hashtags.map((h, i) => (
              <span
                key={`${h}-${i}`}
                className="flex items-center gap-1 rounded-md bg-brand/15 py-0.5 pl-2 pr-1 text-[11px] text-brand"
              >
                #{h}
                <button
                  type="button"
                  onClick={() => removeTag(i)}
                  aria-label={`Hashtag ${h} verwijderen`}
                  title="Verwijderen"
                  className="flex h-4 w-4 items-center justify-center rounded text-brand/80 hover:bg-brand/25 hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              id="tag-input"
              value={tagInput}
              onChange={(e) => {
                const v = e.target.value;
                // komma (ook bij plakken) → alles vóór de laatste komma toevoegen
                if (v.includes(",")) {
                  const cut = v.lastIndexOf(",");
                  commitTags(v.slice(0, cut));
                  setTagInput(v.slice(cut + 1).replace(/[#\s]+/g, ""));
                } else {
                  setTagInput(v);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTags(tagInput);
                } else if (e.key === "Backspace" && !tagInput && caption.hashtags.length) {
                  removeTag(caption.hashtags.length - 1);
                }
              }}
              onBlur={() => {
                if (tagInput.trim()) commitTags(tagInput);
              }}
              placeholder={caption.hashtags.length ? "+ hashtag" : "Typ een hashtag + Enter"}
              className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-[12px] outline-none placeholder:text-muted"
            />
          </div>
          <p className="mt-1 text-[10px] text-muted">Enter of komma om toe te voegen · × om te verwijderen</p>
        </div>
      </div>
    </Card>
  );
}

export function PhonePreview({
  platform,
  media,
  caption,
  placements,
  handle,
}: {
  platform: PlatformId;
  media?: MediaItem;
  caption: PlatformCaption;
  placements: PlacementId[];
  /** echte paginanaam / handle */
  handle: string;
}) {
  const showStory = placements.includes("story");
  const feedLabel =
    platform === "youtube"
      ? placements.includes("video")
        ? "YouTube-video"
        : "Short"
      : placements.includes("reel")
        ? "Reel"
        : platform === "tiktok"
          ? "Video"
          : "Feed";
  const showFeed =
    placements.includes("feed") ||
    placements.includes("reel") ||
    placements.includes("short") ||
    placements.includes("video") ||
    placements.length === 0;

  return (
    <div className="flex flex-col items-center gap-4">
      {showFeed && (
        <PhoneFrame label={feedLabel}>
          <FeedPreview
            platform={platform}
            media={media}
            caption={caption}
            handle={handle}
            youtubeLabel={placements.includes("video") ? "▶ Video" : "▶ Short"}
          />
        </PhoneFrame>
      )}
      {showStory && (
        <PhoneFrame label="Story">
          <StoryPreview media={media} caption={caption} handle={handle} />
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
    <img src={media.previewUrl} alt="" className={`object-cover ${className}`} />
  ) : (
    <video
      src={media.previewUrl}
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
  handle,
  youtubeLabel,
}: {
  platform: PlatformId;
  media?: MediaItem;
  caption: PlatformCaption;
  handle: string;
  youtubeLabel: string;
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
        <span className="truncate text-xs font-semibold">{handle}</span>
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
            {youtubeLabel}
          </span>
        )}
      </div>
      <div className="px-3 pb-3">
        {platform === "youtube" && caption.title && (
          <p className="mb-1 text-xs font-bold">{caption.title}</p>
        )}
        <p className="whitespace-pre-wrap text-[11px] leading-snug">
          <span className="font-semibold">{handle}</span> {caption.caption}
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
  handle,
}: {
  media?: MediaItem;
  caption: PlatformCaption;
  handle: string;
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
          {handle}
        </span>
      </div>
      {/* overlay text */}
      <div className="absolute inset-x-0 bottom-20 px-4 text-center">
        <span className="inline-block rounded-md bg-black/40 px-3 py-1.5 text-sm font-bold text-white backdrop-blur-sm">
          {caption.story}
        </span>
        <span className="mt-1.5 block text-[9px] leading-tight text-white/75 drop-shadow">
          {STORY_PREVIEW_NOTE}
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
