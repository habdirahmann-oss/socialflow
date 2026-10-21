"use client";

import { useEffect, useState } from "react";
import { postJson } from "@/lib/client-fetch";
import {
  TIKTOK_PRIVACY_LABELS,
  type TikTokCreatorInfo,
  type TikTokPostSettings,
} from "@/lib/tiktok-settings";
import type { MediaKind } from "@/lib/types";
import { Switch } from "./ui";

/** Keuzes in het paneel; `privacy` is leeg tot de maker zelf kiest (geen standaardwaarde). */
export interface TikTokDraft extends Omit<TikTokPostSettings, "privacy"> {
  privacy: string;
  /** 'Reclame of samenwerking' aan/uit. */
  commercial: boolean;
}

export const EMPTY_TIKTOK_DRAFT: TikTokDraft = {
  privacy: "",
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  commercial: false,
  yourBrand: false,
  brandedContent: false,
};

/** Wat er nog mist voordat er naar TikTok gepost mag worden (of null). */
export function tiktokDraftProblem(
  d: TikTokDraft,
  info: TikTokCreatorInfo | null,
  videoSeconds?: number,
): string | null {
  if (!d.privacy) return "TikTok: kies wie de post mag zien";
  if (d.commercial && !d.yourBrand && !d.brandedContent) {
    return "TikTok: kies 'Je eigen merk' en/of 'Branded content'";
  }
  if (d.brandedContent && d.privacy === "SELF_ONLY") {
    return "TikTok: branded content kan niet op 'Alleen ik'";
  }
  if (info?.maxVideoSeconds && videoSeconds && videoSeconds > info.maxVideoSeconds) {
    return `TikTok: deze video is te lang (max. ${info.maxVideoSeconds} s voor dit account)`;
  }
  return null;
}

/** De keuzes zoals ze naar de server gaan. */
export function tiktokSettingsFromDraft(d: TikTokDraft): TikTokPostSettings | undefined {
  if (!d.privacy) return undefined;
  return {
    privacy: d.privacy,
    allowComment: d.allowComment,
    allowDuet: d.allowDuet,
    allowStitch: d.allowStitch,
    yourBrand: d.commercial && d.yourBrand,
    brandedContent: d.commercial && d.brandedContent,
  };
}

/** Haalt naam, avatar en postopties van de gekoppelde TikTok-maker op. */
export function useTikTokCreator(accountId: string, enabled: boolean) {
  const [info, setInfo] = useState<TikTokCreatorInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !accountId) return;
    let alive = true;
    postJson<TikTokCreatorInfo>(
      `/api/tiktok/creator-info?account=${encodeURIComponent(accountId)}`,
      undefined,
      "GET",
    )
      .then((d) => {
        if (!alive) return;
        setInfo(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setInfo(null);
        setError(e instanceof Error ? e.message : "TikTok-gegevens ophalen mislukt");
      });
    return () => {
      alive = false;
    };
  }, [accountId, enabled]);
  return { info: enabled ? info : null, error: enabled ? error : null };
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`flex items-center gap-2 text-xs ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-[var(--color-accent,#22c55e)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

/**
 * TikTok-instellingen per post, volgens TikTok's Content Sharing Guidelines:
 * maker zichtbaar, zichtbaarheid zelf kiezen (geen standaard), interacties
 * standaard uit, reclame-melding en de toestemmingstekst.
 */
export function TikTokSettingsPanel({
  draft,
  onChange,
  info,
  error,
  mediaKind,
}: {
  draft: TikTokDraft;
  onChange: (d: TikTokDraft) => void;
  info: TikTokCreatorInfo | null;
  error: string | null;
  mediaKind?: MediaKind;
}) {
  const set = (patch: Partial<TikTokDraft>) => onChange({ ...draft, ...patch });
  const isPhoto = mediaKind === "image";
  const options = info?.privacyOptions ?? [];

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-surface-2/40 p-3">
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      {info && (
        <div className="flex items-center gap-2">
          {info.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={info.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
          ) : (
            <span className="h-7 w-7 rounded-full bg-border" />
          )}
          <p className="text-xs">
            Posten als <span className="font-semibold">{info.nickname}</span>
            {info.username && <span className="text-muted"> @{info.username}</span>}
          </p>
        </div>
      )}

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Wie mag deze post zien?</span>
        <select
          value={draft.privacy}
          onChange={(e) => set({ privacy: e.target.value })}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs"
        >
          <option value="" disabled>
            Kies zichtbaarheid…
          </option>
          {options.map((o) => (
            <option
              key={o}
              value={o}
              disabled={o === "SELF_ONLY" && draft.commercial && draft.brandedContent}
            >
              {TIKTOK_PRIVACY_LABELS[o] || o}
            </option>
          ))}
        </select>
        {draft.commercial && draft.brandedContent && (
          <span className="text-[10px] text-muted">
            Branded content kan niet privé (&lsquo;Alleen ik&rsquo;) worden geplaatst.
          </span>
        )}
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Kijkers toestaan om</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          <Check
            checked={draft.allowComment}
            disabled={info?.commentDisabled}
            onChange={(v) => set({ allowComment: v })}
          >
            Reageren
          </Check>
          {!isPhoto && (
            <>
              <Check
                checked={draft.allowDuet}
                disabled={info?.duetDisabled}
                onChange={(v) => set({ allowDuet: v })}
              >
                Duet
              </Check>
              <Check
                checked={draft.allowStitch}
                disabled={info?.stitchDisabled}
                onChange={(v) => set({ allowStitch: v })}
              >
                Stitch
              </Check>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium">Reclame of samenwerking</p>
            <p className="text-[10px] text-muted">
              Zet aan als deze post een merk, product of dienst promoot.
            </p>
          </div>
          <Switch
            on={draft.commercial}
            label="Reclame of samenwerking"
            onClick={() =>
              set(
                draft.commercial
                  ? { commercial: false, yourBrand: false, brandedContent: false }
                  : { commercial: true },
              )
            }
          />
        </div>
        {draft.commercial && (
          <div className="flex flex-col gap-1.5 pl-1">
            <Check checked={draft.yourBrand} onChange={(v) => set({ yourBrand: v })}>
              Je eigen merk
            </Check>
            <Check
              checked={draft.brandedContent}
              onChange={(v) =>
                set(
                  v && draft.privacy === "SELF_ONLY"
                    ? { brandedContent: v, privacy: "" }
                    : { brandedContent: v },
                )
              }
            >
              Branded content (betaalde samenwerking)
            </Check>
            {(draft.yourBrand || draft.brandedContent) && (
              <p className="text-[10px] text-amber-700">
                Je {isPhoto ? "foto" : "video"} krijgt het label &lsquo;
                {draft.brandedContent ? "Paid partnership" : "Promotional content"}&rsquo;.
              </p>
            )}
            {!draft.yourBrand && !draft.brandedContent && (
              <p className="text-[10px] text-muted">
                Kies minstens één optie om te kunnen posten.
              </p>
            )}
          </div>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-muted">
        Door te posten ga je akkoord met TikTok&rsquo;s{" "}
        {draft.commercial && draft.brandedContent && (
          <>
            <a
              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand underline-offset-2 hover:underline"
            >
              Branded Content Policy
            </a>{" "}
            en{" "}
          </>
        )}
        <a
          href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline-offset-2 hover:underline"
        >
          Music Usage Confirmation
        </a>
        . Na het posten kan het een paar minuten duren voordat de post op je profiel staat.
      </p>
    </div>
  );
}
