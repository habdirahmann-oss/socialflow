import { NextResponse } from "next/server";
import { PLATFORM_MAP, type PlatformId } from "@/lib/platforms";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";

interface CaptionRequest {
  subject: string;
  tone: string;
  platforms: PlatformId[];
}

export interface PlatformCaption {
  title?: string; // vooral voor YouTube
  caption: string;
  story: string; // korte overlay-tekst voor de story
  hashtags: string[];
}

export type CaptionResult = Record<string, PlatformCaption>;

const MODEL = "claude-opus-4-8";

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: CaptionRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige aanvraag" }, { status: 400 });
  }

  const subject = (body.subject || "").trim();
  const tone = body.tone || "Enthousiast";
  const platforms = (body.platforms || []).filter((p) => PLATFORM_MAP[p]);

  if (platforms.length === 0) {
    return NextResponse.json({ error: "Geen platforms gekozen" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    try {
      const result = await generateWithClaude(apiKey, subject, tone, platforms);
      return NextResponse.json({ result, source: "claude" });
    } catch (err) {
      console.error("Claude-fout, val terug op lokale generator:", err);
    }
  }

  const result = localGenerate(subject, tone, platforms);
  return NextResponse.json({ result, source: "lokaal" });
}

async function generateWithClaude(
  apiKey: string,
  subject: string,
  tone: string,
  platforms: PlatformId[],
): Promise<CaptionResult> {
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

  const userPrompt = `Onderwerp: "${subject || "(geen onderwerp — bedenk zelf een sterke, relevante invalshoek op basis van de media)"}"
Gewenste toon: ${tone}

Schrijf originele, hoogwaardige captions voor deze platforms:
${specs}

Richtlijnen per platform:
- instagram: open met een pakkende hook (regel 1), daarna 1-3 korte zinnen die waarde of gevoel toevoegen, sluit af met een natuurlijke vraag of CTA. Persoonlijk en vlot.
- tiktok: kort, direct en trend-bewust. Eén rake zin of vraag. Casual, geen marketingtaal.
- facebook: iets langer en conversationeel, alsof je iets deelt met je community.
- youtube: een klikwaardige, duidelijke TITEL (max ~70 tekens, geen goedkope clickbait) plus een beschrijving die context en waarde geeft.

Kwaliteitsregels (belangrijk):
- Geen clichés of vulzinnen. Als het op elke willekeurige post zou passen, herschrijf het.
- Natuurlijk Nederlands — geen letterlijke vertaling, geen stijve AI-taal.
- Emoji spaarzaam en met smaak.
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
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonStr) as CaptionResult;

  // normaliseer en vul ontbrekende platforms aan met de lokale generator
  const result: CaptionResult = {};
  for (const p of platforms) {
    const c = parsed[p];
    if (c && c.caption) {
      result[p] = {
        title: c.title || "",
        caption: c.caption,
        story: c.story || subject || "",
        hashtags: Array.isArray(c.hashtags)
          ? c.hashtags.map((h) => h.replace(/^#/, "").trim()).filter(Boolean)
          : [],
      };
    } else {
      result[p] = localGenerate(subject, tone, [p])[p];
    }
  }
  return result;
}

/* ---------- Lokale fallback-generator (werkt zonder API-key) ---------- */

const HOOKS = [
  "Dit wil je niet missen",
  "Even iets delen",
  "Nieuw bij ons",
  "Kijk eens mee",
  "Vers van de pers",
  "Speciaal voor jou",
];

const CTAS = [
  "Wat vind jij? 👇",
  "Sla dit op voor later 🔖",
  "Tag iemand die dit moet zien!",
  "Meer weten? Stuur ons een DM 💬",
  "Like als je het ook zo voelt ❤️",
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

function localGenerate(
  subject: string,
  tone: string,
  platforms: PlatformId[],
): CaptionResult {
  const result: CaptionResult = {};
  const words = keywords(subject);
  const emoji = TONE_EMOJI[tone] || "✨";
  const seed = subject.length + tone.length;

  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    const pl = PLATFORM_MAP[p];
    const hook = pick(HOOKS, seed + i);
    const cta = pick(CTAS, seed + i + 1);
    const topic = subject || "onze nieuwste content";

    const baseHashtags = [
      ...words.slice(0, 4),
      pl.id,
      "content",
      "socialmedia",
      "trending",
      "viral",
      "nederland",
    ]
      .filter(Boolean)
      .slice(0, pl.hashtags);

    let caption: string;
    switch (p) {
      case "youtube":
        caption = `${hook}! In deze video laten we je alles zien over ${topic}. ${emoji}\n\nVeel kijkplezier — abonneer voor meer!`;
        break;
      case "tiktok":
        caption = `${topic} ${emoji} ${cta}`;
        break;
      case "facebook":
        caption = `${hook} ${emoji}\n\nVandaag delen we graag iets over ${topic}. ${cta}`;
        break;
      default: // instagram
        caption = `${hook} ${emoji}\n\n${topic.charAt(0).toUpperCase() + topic.slice(1)}. ${cta}`;
    }

    result[p] = {
      title: p === "youtube" ? `${topic.charAt(0).toUpperCase() + topic.slice(1)} ${emoji}` : "",
      caption,
      story: (subject ? subject.slice(0, 55) : "Nieuw! Swipe up 👆"),
      hashtags: baseHashtags,
    };
  }
  return result;
}
