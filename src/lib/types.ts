/**
 * Gedeelde types — puur type-only en client-veilig (geen runtime-imports).
 *
 * lib/ importeert nooit uit app/api; types die door routes, lib en UI gedeeld
 * worden staan hier.
 */
import type { PlacementId, PlatformId } from "./platforms";

/** Soort media van een post. */
export type MediaKind = "image" | "video";

/* ---------------- Captions ---------------- */

export interface PlatformCaption {
  /** Vooral voor YouTube (max. 100 tekens). */
  title?: string;
  /** Hoofdtekst, ZONDER hashtags. */
  caption: string;
  /** Korte overlay-tekst voor de story-preview. */
  story: string;
  /** Losse hashtags zonder '#'. */
  hashtags: string[];
}

/** Captions per kanaal. Gebruik `Partial<CaptionResult>` als niet alle kanalen er zijn. */
export type CaptionResult = Record<PlatformId, PlatformCaption>;

/** Gevraagde plaatsingen per kanaal (bv. { youtube: ["short"], instagram: ["reel", "story"] }). */
export type PlacementsByPlatform = Partial<Record<PlatformId, PlacementId[]>>;

/** Body van POST /api/captions. */
export interface CaptionRequest {
  subject?: string;
  tone?: string;
  platforms: PlatformId[];
  mediaType?: MediaKind;
  placements?: PlacementsByPlatform;
  accountName?: string;
}

/** Antwoord van POST /api/captions. */
export interface CaptionResponse {
  result?: Partial<CaptionResult>;
  source?: "claude" | "lokaal";
  error?: string;
}

/* ---------------- Koppelingsgezondheid ---------------- */

export type HealthStatus = "ok" | "expiring" | "needs_reauth";

/** Wat GET /api/accounts per kanaal teruggeeft — nooit tokens. */
export interface ChannelHealth {
  status: HealthStatus;
  expiresAt?: number;
  lastError?: string;
  connectedAt?: number;
}

export type AccountHealth = Partial<Record<PlatformId, ChannelHealth>>;

/* ---------------- GET /api/accounts ---------------- */

export interface AccountPage {
  id: string;
  name: string;
  /** Instagram-gebruikersnaam van de pagina, of null. */
  instagram: string | null;
}

/** Eén account zoals GET /api/accounts het teruggeeft (nooit tokens). */
export interface AccountInfo {
  id: string;
  name: string;
  createdAt: number;
  facebook: boolean;
  instagram: boolean;
  pages: AccountPage[];
  /** Pagina waarmee dit account nu post (null = nog kiezen). */
  selectedPageId: string | null;
  /** Nieuwe koppeling met meerdere pagina's zonder keuze: posten geblokkeerd. */
  pageChoiceRequired?: boolean;
  /** Oude koppeling die stil op de eerste pagina terugvalt. */
  implicitPage?: boolean;
  /** Via welke route Instagram publiceert. */
  igPublishVia?: { username: string; route: "login" | "page" } | null;
  /** Aantal wachtende geplande posts. */
  pendingPosts?: number;
  connectedAt: number | null;
  igLogin: { username: string } | null;
  tiktok: { displayName: string } | null;
  youtube: { channelTitle: string } | null;
  health?: AccountHealth;
}

/** Volledig antwoord van GET /api/accounts. */
export interface AccountsResponse {
  configured: boolean;
  igConfigured: boolean;
  tiktokConfigured: boolean;
  youtubeConfigured: boolean;
  appUrl: string;
  maxAccounts: number;
  accounts: AccountInfo[];
}
