import { stripDashes } from "@/lib/caption-text";
import { NextResponse } from "next/server";
import {
  PLATFORM_MAP,
  PLATFORMS,
  type PlacementId,
  type PlatformId,
} from "@/lib/platforms";
import { requireAuth } from "@/lib/auth";
import { kvGet, kvSet } from "@/lib/store";
import type {
  CaptionResponse,
  CaptionResult,
  MediaKind,
  PlacementsByPlatform,
  PlatformCaption,
} from "@/lib/types";

export const runtime = "nodejs";

const MODEL = "claude-opus-4-8";

/** Maximale lengte van het onderwerp (tekens). */
const SUBJECT_MAX = 500;
/** Maximale lengte van een YouTube-titel. */
const YT_TITLE_MAX = 100;
/** Max. aantal caption-aanvragen per uur, voor iedereen samen. */
const RATE_LIMIT_PER_HOUR = 60;
const RATE_LIMIT_MSG = "Even rustig aan — probeer het over een paar minuten";

type Captions = Partial<CaptionResult>;

const json = (body: CaptionResponse, status = 200) => NextResponse.json(body, { status });

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    body = raw as Record<string, unknown>;
  } catch {
    return json({ error: "Ongeldige aanvraag" }, 400);
  }

  const subject = (typeof body.subject === "string" ? body.subject : "").trim();
  if (subject.length > SUBJECT_MAX) {
    return json(
      { error: `Onderwerp is te lang (${subject.length} tekens, max. ${SUBJECT_MAX})` },
      400,
    );
  }
  const tone = typeof body.tone === "string" && body.tone.trim() ? body.tone.trim().slice(0, 40) : "Enthousiast";
  const platforms = (Array.isArray(body.platforms) ? body.platforms : []).filter(
    (p, i, arr): p is PlatformId =>
      typeof p === "string" && p in PLATFORM_MAP && arr.indexOf(p) === i,
  );
  if (platforms.length === 0) {
    return json({ error: "Geen platforms gekozen" }, 400);
  }
  const mediaType: MediaKind | undefined =
    body.mediaType === "image" || body.mediaType === "video" ? body.mediaType : undefined;
  const placements = sanitizePlacements(body.placements, platforms);
  const accountName = sanitizeName(body.accountName);

  if (await rateLimited()) {
    return json({ error: RATE_LIMIT_MSG }, 429);
  }

  const ctx: PromptContext = { subject, tone, platforms, mediaType, placements, accountName };
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    try {
      const result = await generateWithClaude(apiKey, ctx);
      return json({ result: finalize(result, ctx), source: "claude" });
    } catch (err) {
      console.error(
        "Claude-fout, val terug op lokale generator:",
        err instanceof Error ? err.message.slice(0, 300) : err,
      );
    }
  }

  return json({ result: finalize(localGenerate(ctx), ctx), source: "lokaal" });
}

/* ---------------- Invoer opschonen ---------------- */

const PLACEMENT_IDS = new Set<PlacementId>(
  PLATFORMS.flatMap((p) => p.placements.map((pl) => pl.id)),
);

/** Alleen bekende kanalen/plaatsingen, en alleen voor de gevraagde kanalen. */
function sanitizePlacements(raw: unknown, platforms: PlatformId[]): PlacementsByPlatform {
  const out: PlacementsByPlatform = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const p of platforms) {
    const list = (raw as Record<string, unknown>)[p];
    if (!Array.isArray(list)) continue;
    const clean: PlacementId[] = [];
    for (const x of list) {
      // 'feed' is de oude YouTube-id voor 'video'
      const id = p === "youtube" && x === "feed" ? "video" : x;
      if (typeof id === "string" && PLACEMENT_IDS.has(id as PlacementId)) {
        if (!clean.includes(id as PlacementId)) clean.push(id as PlacementId);
      }
    }
    if (clean.length) out[p] = clean;
  }
  return out;
}

/** Accountnaam veilig in de prompt: geen regeleinden/aanhalingstekens, max. 80 tekens. */
function sanitizeName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw
    .replace(/[\u0000-\u001f\u007f"`\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return s || undefined;
}

/* ---------------- Rate limit ---------------- */

/**
 * Simpele teller per uur (`rl:captions:<uur>`), gedeeld door iedereen.
 * Niet atomisch (get + set), maar ruim voldoende als kostenrem. Als de opslag
 * faalt, laten we de aanvraag door (liever werken dan blokkeren).
 */
async function rateLimited(): Promise<boolean> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `rl:captions:${hour}`;
  try {
    const n = Number(await kvGet<number>(key)) || 0;
    if (n >= RATE_LIMIT_PER_HOUR) return true;
    await kvSet(key, n + 1, { exSeconds: 2 * 3600 });
  } catch (e) {
    console.error("Rate-limit-teller niet beschikbaar:", e instanceof Error ? e.message : e);
  }
  return false;
}

/* ---------------- Prompt ---------------- */

interface PromptContext {
  subject: string;
  tone: string;
  platforms: PlatformId[];
  mediaType?: MediaKind;
  placements: PlacementsByPlatform;
  accountName?: string;
}

const isShort = (ctx: PromptContext) => Boolean(ctx.placements.youtube?.includes("short"));

/** Beschrijft per kanaal waar de post terechtkomt (Reel, Short, Story …). */
function placementLines(ctx: PromptContext): string[] {
  const lines: string[] = [];
  for (const p of ctx.platforms) {
    const plc = ctx.placements[p] || [];
    switch (p) {
      case "instagram": {
        const parts: string[] = [];
        if (plc.includes("reel") || (ctx.mediaType === "video" && plc.includes("feed"))) {
          parts.push("een Reel (korte verticale video): hook in regel 1, kort en scanbaar");
        } else if (plc.includes("feed")) {
          parts.push("een feed-post met foto");
        }
        if (plc.includes("story")) {
          parts.push("plus een Story ('story' = korte overlay-zin)");
        }
        if (parts.length) lines.push(`- instagram: ${parts.join(", ")}`);
        break;
      }
      case "youtube":
        if (plc.includes("short")) {
          lines.push(
            `- youtube: een YouTube SHORT (verticaal, max. 3 min). Zet "#Shorts" in de titel (titel incl. #Shorts max. ${YT_TITLE_MAX} tekens). Houd de beschrijving kort.`,
          );
        } else if (plc.includes("video")) {
          lines.push(
            "- youtube: een gewone (horizontale/lange) YouTube-video — GEEN #Shorts in de titel; de beschrijving mag uitgebreider (context, wat je leert/ziet).",
          );
        }
        break;
      case "tiktok":
        lines.push("- tiktok: een TikTok-video");
        break;
      case "facebook":
        lines.push(
          `- facebook: ${
            ctx.mediaType === "video"
              ? "een video-post"
              : ctx.mediaType === "image"
                ? "een post met foto"
                : "een tekstpost zonder media"
          }`,
        );
        break;
    }
  }
  return lines;
}

function mediaLine(ctx: PromptContext): string {
  if (ctx.mediaType === "video") {
    return "Media: VIDEO. De eerste regel van elke caption (en van de YouTube-beschrijving) is een sterke hook die in 1-2 seconden duidelijk maakt waarom je moet blijven kijken — specifiek voor dit onderwerp, geen cliché.";
  }
  if (ctx.mediaType === "image") return "Media: FOTO.";
  return "Media: (nog) geen media gekozen.";
}

async function generateWithClaude(apiKey: string, ctx: PromptContext): Promise<Captions> {
  const { subject, tone, platforms } = ctx;
  const specs = platforms
    .map((p) => {
      const pl = PLATFORM_MAP[p];
      return `- ${pl.id} (${pl.name}): max ${pl.maxChars} tekens, ${pl.hashtags} hashtags`;
    })
    .join("\n");

  const system =
    "Je bent een topcopywriter voor social media die schrijft in vlot, natuurlijk Nederlands. " +
    "Je captions stoppen de scroll: sterke eerste regel (hook), menselijke toon, en een subtiele call-to-action. " +
    "Je schrijft NOOIT generieke vulzinnen of clichés zoals 'Dit wil je niet missen', 'Vers van de pers', " +
    "'Speciaal voor jou', 'Kijk eens mee' of 'Even iets delen'. Elke caption voelt specifiek voor dít onderwerp. " +
    "Je past toon en lengte aan per platform en gebruikt emoji met mate (niet in elke zin). " +
    "Antwoord ALTIJD met UITSLUITEND geldige JSON, zonder uitleg eromheen.";

  const where = placementLines(ctx);
  const userPrompt = `Onderwerp: "${subject || "(geen onderwerp — bedenk zelf een sterke, relevante invalshoek op basis van de media)"}"
Gewenste toon: ${tone}${
    ctx.accountName
      ? `\nAccount/merk: ${ctx.accountName} — schrijf passend bij dit account (noem de naam alleen als dat natuurlijk voelt).`
      : ""
  }
${mediaLine(ctx)}${where.length ? `\n\nWaar de post komt te staan:\n${where.join("\n")}` : ""}

Schrijf originele, hoogwaardige captions voor deze platforms:
${specs}

Richtlijnen per platform:
- instagram: open met een pakkende hook (regel 1), daarna 1-3 korte zinnen die waarde of gevoel toevoegen, sluit af met een natuurlijke vraag of CTA. Persoonlijk en vlot.
- tiktok: kort, direct en trend-bewust. Eén rake zin of vraag. Casual, geen marketingtaal.
- facebook: iets langer en conversationeel, alsof je iets deelt met je community.
- youtube: een klikwaardige, duidelijke TITEL (max ~70 tekens, absoluut max ${YT_TITLE_MAX}, geen goedkope clickbait) plus een beschrijving die context en waarde geeft.

Kwaliteitsregels (belangrijk):
- Geen clichés of vulzinnen. Als het op elke willekeurige post zou passen, herschrijf het.
- Natuurlijk Nederlands — geen letterlijke vertaling, geen stijve AI-taal.
- Emoji spaarzaam en met smaak.
- Gebruik GEEN streepjes (—, – of -) tussen tekst of zinsdelen. Gebruik een komma, punt of dubbele punt, of begin een nieuwe zin.
- Hashtags: relevant en gemengd (een paar breed + een paar niche), geen spam, exact het gevraagde aantal.

Geef per platform:
- "title": alleen voor youtube een echte titel; anders lege string
- "caption": de hoofdtekst, ZONDER de hashtags erin
- "story": 1 korte, pakkende overlay-zin (max 60 tekens)
- "hashtags": array met losse hashtags zonder #-teken

Antwoord met UITSLUITEND geldige JSON in exact dit formaat:
{ "platform_id": { "title": "", "caption": "", "story": "", "hashtags": ["", ""] } }
Gebruik exact deze platform-id's als sleutels: ${platforms.join(", ")}.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks: { type?: string; text?: string }[] = Array.isArray(data?.content)
    ? data.content
    : [];
  const text: string = blocks.find((b) => b?.type === "text")?.text ?? "";
  const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonStr) as Record<string, Partial<PlatformCaption> | undefined>;

  // normaliseer en vul ontbrekende platforms aan met de lokale generator
  const result: Captions = {};
  for (const p of platforms) {
    const c = parsed[p];
    if (c && typeof c.caption === "string" && c.caption.trim()) {
      result[p] = {
        title: typeof c.title === "string" ? c.title : "",
        caption: c.caption,
        story: (typeof c.story === "string" && c.story) || subject.slice(0, 60) || "",
        hashtags: Array.isArray(c.hashtags) ? c.hashtags.filter((h) => typeof h === "string") : [],
      };
    } else {
      result[p] = localGenerate({ ...ctx, platforms: [p] })[p];
    }
  }
  return result;
}

/* ---------------- Nabewerking (Claude én lokaal) ---------------- */

/** Hashtag zonder '#' en spaties. */
const cleanTag = (h: string) => h.replace(/[#\s]+/g, "").trim();

/**
 * - hashtags opgeschoond en ontdubbeld
 * - YouTube-titel max. 100 tekens; bij een Short altijd met #Shorts
 */
function finalize(result: Captions, ctx: PromptContext): Captions {
  const out: Captions = {};
  for (const [pid, c] of Object.entries(result) as [PlatformId, PlatformCaption][]) {
    const seen = new Set<string>();
    const hashtags = c.hashtags.map(cleanTag).filter((h) => {
      const k = h.toLowerCase();
      if (!h || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    let title = (c.title || "").replace(/\s+/g, " ").trim();
    if (pid === "youtube") {
      if (isShort(ctx) && !/#shorts\b/i.test(title)) {
        const tag = " #Shorts";
        title = `${title.slice(0, YT_TITLE_MAX - tag.length).trim()}${tag}`.trim();
      }
      title = title.slice(0, YT_TITLE_MAX);
    } else {
      title = "";
    }
    out[pid] = {
      ...c,
      title: stripDashes(title),
      caption: stripDashes(c.caption),
      story: stripDashes(c.story || ""),
      hashtags,
    };
  }
  return out;
}

/* ---------- Lokale fallback-generator (werkt zonder API-key) ---------- */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Neutrale openingen — geen clickbait of vulzinnen. */
const HOOKS: ((topic: string) => string)[] = [
  (t) => cap(t),
  (t) => `Vandaag: ${t}`,
  (t) => `Een update over ${t}`,
  (t) => `Uitgelicht: ${t}`,
  (t) => `Zo zit het met ${t}`,
];

const CTAS = [
  "Wat vind jij? Laat het weten in de reacties.",
  "Sla dit op voor later.",
  "Vragen? Stuur ons gerust een bericht.",
  "Deel het met iemand voor wie dit nuttig is.",
];

const TONE_EMOJI: Record<string, string> = {
  Enthousiast: "🔥",
  Professioneel: "✨",
  "Speels & grappig": "😄",
  Inspirerend: "🌟",
  Informatief: "📌",
  "Stoer & kort": "⚡",
};

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

function keywords(subject: string): string[] {
  const stop = new Set([
    "de", "het", "een", "en", "van", "met", "voor", "op", "in", "is",
    "the", "a", "of", "to", "and",
  ]);
  return subject
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function localGenerate(ctx: PromptContext): Captions {
  const { subject, tone, platforms } = ctx;
  const result: Captions = {};
  const words = keywords(subject);
  const emoji = TONE_EMOJI[tone] || "✨";
  const seed = subject.length + tone.length;

  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    const pl = PLATFORM_MAP[p];
    const topic = subject || "onze nieuwste content";
    const hook = pick(HOOKS, seed + i)(topic);
    const cta = pick(CTAS, seed + i + 1);

    const baseHashtags = [...words.slice(0, 4), pl.id, "nederland", "content", "socialmedia"]
      .filter(Boolean)
      .slice(0, pl.hashtags);

    let caption: string;
    switch (p) {
      case "youtube":
        caption = `${hook} ${emoji}\n\nIn deze ${
          isShort(ctx) ? "Short" : "video"
        } zie je meer over ${topic}.\n\n${cta}`;
        break;
      case "tiktok":
        caption = `${cap(topic)} ${emoji} ${cta}`;
        break;
      case "facebook":
        caption = `${hook} ${emoji}\n\n${cta}`;
        break;
      default: // instagram
        caption = `${hook} ${emoji}\n\n${cta}`;
    }

    result[p] = {
      title: p === "youtube" ? cap(topic).slice(0, 90) : "",
      caption,
      story: subject ? subject.slice(0, 55) : "Nieuw",
      hashtags: baseHashtags,
    };
  }
  return result;
}
