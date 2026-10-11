export type PlatformId = "instagram" | "tiktok" | "facebook" | "youtube";

export type PlacementId = "feed" | "story" | "reel" | "short";

export interface Platform {
  id: PlatformId;
  name: string;
  color: string;
  /** lichte achtergrond-gradient voor previews */
  gradient: string;
  /** korte beschrijving van wat erheen gaat */
  blurb: string;
  /** beschikbare plaatsingen */
  placements: { id: PlacementId; label: string }[];
  /** max caption-lengte (richtlijn) */
  maxChars: number;
  /** aantal hashtags dat de AI moet voorstellen */
  hashtags: number;
}

export const PLATFORMS: Platform[] = [
  {
    id: "instagram",
    name: "Instagram",
    color: "#E1306C",
    gradient: "linear-gradient(135deg,#f58529,#dd2a7b,#8134af)",
    blurb: "Feed-post + Story",
    placements: [
      { id: "feed", label: "Feed" },
      { id: "story", label: "Story" },
      { id: "reel", label: "Reel" },
    ],
    maxChars: 2200,
    hashtags: 8,
  },
  {
    id: "tiktok",
    name: "TikTok",
    color: "#25F4EE",
    gradient: "linear-gradient(135deg,#25F4EE,#000,#FE2C55)",
    blurb: "Video + Story",
    placements: [
      { id: "feed", label: "Video" },
      { id: "story", label: "Story" },
    ],
    maxChars: 2200,
    hashtags: 6,
  },
  {
    id: "facebook",
    name: "Facebook",
    color: "#1877F2",
    gradient: "linear-gradient(135deg,#1877F2,#0a3d8f)",
    blurb: "Pagina-post + Story",
    placements: [
      { id: "feed", label: "Post" },
      { id: "story", label: "Story" },
    ],
    maxChars: 5000,
    hashtags: 3,
  },
  {
    id: "youtube",
    name: "YouTube",
    color: "#FF0000",
    gradient: "linear-gradient(135deg,#FF0000,#7a0000)",
    blurb: "Short / Video",
    placements: [
      { id: "short", label: "Short" },
      { id: "feed", label: "Video" },
    ],
    maxChars: 5000,
    hashtags: 4,
  },
];

export const PLATFORM_MAP: Record<PlatformId, Platform> = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p]),
) as Record<PlatformId, Platform>;

export const TONES = [
  "Enthousiast",
  "Professioneel",
  "Speels & grappig",
  "Inspirerend",
  "Informatief",
  "Stoer & kort",
] as const;

export type Tone = (typeof TONES)[number];
