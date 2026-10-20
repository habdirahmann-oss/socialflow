import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  publishForAccount,
  resolveMediaInput,
  type MediaInput,
  type PublishTargets,
  type PublishCaptions,
  type PublishOutcome,
} from "@/lib/publish";
import { requireAuth } from "@/lib/auth";
import { listAccounts } from "@/lib/accounts";
import { normalizeTargets } from "@/lib/targets";
import { publishDirectWithHistory } from "@/lib/history";

export const runtime = "nodejs";
export const maxDuration = 300; // video's kunnen even duren (Hobby + Fluid Compute: max 300 s)

interface PublishBody {
  accountId?: unknown;
  /** Bij voorkeur { url, type } (directe upload); { dataUrl, type } blijft als fallback. */
  media?: MediaInput | null;
  targets?: unknown;
  captions?: unknown;
  subject?: unknown;
  dryRun?: unknown;
  /** Alleen lokaal testen (zie testHistoryAllowed): testmodus mét geschiedenis. */
  testHistory?: unknown;
}

/**
 * Testhaak: een dry-run die tóch een geschiedenis-entry schrijft, zodat het
 * history-pad lokaal getest kan worden zonder echt te posten. Alleen buiten
 * productie én met SOCIALFLOW_TEST_HISTORY=1.
 */
function testHistoryAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SOCIALFLOW_TEST_HISTORY === "1"
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function bad(error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status: 400 });
}

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  let body: PublishBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige aanvraag" }, { status: 400 });
  }
  if (!isPlainObject(body)) return bad("Ongeldige aanvraag");
  if (typeof body.accountId !== "string" || !body.accountId) {
    return bad("Kies eerst een account");
  }
  const account = (await listAccounts()).find((a) => a.id === body.accountId);
  if (!account) return bad("Onbekend account");
  if (!isPlainObject(body.targets)) return bad("Kies minstens één kanaal");
  if (body.captions !== undefined && body.captions !== null && !isPlainObject(body.captions)) {
    return bad("Ongeldige captions");
  }
  const dryRun = body.dryRun === true;

  let media: Awaited<ReturnType<typeof resolveMediaInput>>;
  try {
    media = await resolveMediaInput(body.media as MediaInput | null | undefined, dryRun);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Media opslaan mislukt" },
      { status: 400 },
    );
  }

  const captions = (body.captions ?? {}) as PublishCaptions;
  const requestedTargets = body.targets as PublishTargets;

  // Testmodus schrijft geen geschiedenis (behalve met de lokale testhaak).
  const record = !dryRun || (body.testHistory === true && testHistoryAllowed());

  let out: PublishOutcome;
  let historyId: string | undefined;
  if (record) {
    historyId = randomUUID();
    try {
      ({ out } = await publishDirectWithHistory({
        id: historyId,
        accountId: account.id,
        accountName: account.name,
        subject:
          typeof body.subject === "string" && body.subject.trim()
            ? body.subject.trim().slice(0, 500)
            : "(zonder onderwerp)",
        mediaUrl: media?.url,
        mediaType: media?.type,
        targets: normalizeTargets(requestedTargets, media?.type).targets,
        requestedTargets,
        captions,
        dryRun,
      }));
    } catch (e) {
      // De 'processing'-entry kon niet geschreven worden → niets gepubliceerd.
      return NextResponse.json(
        {
          error: `Niet gepost: ${e instanceof Error ? e.message : "geschiedenis opslaan mislukt"}`,
        },
        { status: 503 },
      );
    }
  } else {
    out = await publishForAccount({
      accountId: account.id,
      mediaUrl: media?.url,
      mediaType: media?.type,
      targets: requestedTargets,
      captions,
      dryRun,
    });
  }

  const extra = historyId ? { historyId } : {};
  if (out.error) {
    return bad(out.error, { dropped: out.dropped, results: out.results, ...extra });
  }
  return NextResponse.json({ ...out, ...extra });
}
