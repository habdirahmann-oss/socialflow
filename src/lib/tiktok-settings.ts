/**
 * Keuzes die de maker per TikTok-post zelf maakt (verplicht voor Direct Post,
 * zie TikTok's Content Sharing Guidelines). Client-veilig: geen runtime-imports.
 */
export interface TikTokPostSettings {
  /** Eén van creator_info.privacy_level_options; nooit door de app gekozen. */
  privacy: string;
  allowComment: boolean;
  /** Alleen video. */
  allowDuet: boolean;
  /** Alleen video. */
  allowStitch: boolean;
  /** Reclame voor je eigen merk → label 'Promotional content'. */
  yourBrand: boolean;
  /** Betaalde samenwerking → label 'Paid partnership'. */
  brandedContent: boolean;
}

/** Wat GET /api/tiktok/creator-info teruggeeft. */
export interface TikTokCreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number;
}

export const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Iedereen",
  MUTUAL_FOLLOW_FRIENDS: "Vrienden",
  FOLLOWER_OF_CREATOR: "Volgers",
  SELF_ONLY: "Alleen ik",
};

/** Validatie van wat de client meestuurt; ongeldig → undefined. */
export function parseTikTokSettings(v: unknown): TikTokPostSettings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.privacy !== "string" || !TIKTOK_PRIVACY_LABELS[o.privacy]) return undefined;
  const b = (x: unknown) => x === true;
  return {
    privacy: o.privacy,
    allowComment: b(o.allowComment),
    allowDuet: b(o.allowDuet),
    allowStitch: b(o.allowStitch),
    yourBrand: b(o.yourBrand),
    brandedContent: b(o.brandedContent),
  };
}
