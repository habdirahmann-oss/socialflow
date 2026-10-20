import { NextResponse } from "next/server";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { issueSignedToken } from "@vercel/blob";
import { requireAuth } from "@/lib/auth";
import {
  useBlob,
  APP_URL,
  UPLOAD_MIME,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_PATH_RE,
  MAX_UPLOAD_BYTES,
  normalizeMime,
  saveLocalStream,
} from "@/lib/media";

/**
 * Directe uploads vanuit de browser.
 *
 * - Blob-modus (Vercel): de browser vraagt hier een presigned PUT-URL op
 *   (handleUploadPresigned + issueSignedToken, werkt met OIDC/BLOB_STORE_ID)
 *   en uploadt het bestand daarna rechtstreeks naar Vercel Blob. Deze route
 *   ziet het bestand zelf dus nooit (geen 4,5 MB-limiet).
 * - Lokale modus (ontwikkelen zonder Blob): POST ?local=1 met het ruwe bestand
 *   als body; wordt in .data/media opgeslagen.
 *
 * Let op: deze route staat buiten de proxy-matcher (die buffert bodies tot
 * 10 MB), daarom controleert hij de sessie hier zelf.
 */

export const runtime = "nodejs";

const SIGNED_TOKEN_TTL_MS = 15 * 60_000;

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function GET(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  return NextResponse.json({ mode: useBlob ? "blob" : "local" });
}

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  if (new URL(req.url).searchParams.get("local") === "1") {
    return localUpload(req);
  }

  let body: HandleUploadPresignedBody;
  try {
    body = await req.json();
  } catch {
    return bad("Ongeldige aanvraag");
  }
  // Alleen URL-uitgifte; upload-completed callbacks gebruiken we niet.
  if (!body || body.type !== "blob.generate-presigned-url") {
    return bad("Ongeldige aanvraag");
  }
  const pathname = body.payload?.pathname;
  if (typeof pathname !== "string" || !UPLOAD_PATH_RE.test(pathname)) {
    return bad("Ongeldig bestandspad");
  }
  if (!useBlob) {
    return bad("Blob-opslag is hier niet beschikbaar (lokale modus)");
  }

  try {
    const result = await handleUploadPresigned({
      body,
      request: req,
      webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || "unused",
      getSignedToken: async (path) => {
        if (!UPLOAD_PATH_RE.test(path)) throw new Error("Ongeldig bestandspad");
        const validUntil = Date.now() + SIGNED_TOKEN_TTL_MS;
        const token = await issueSignedToken({
          pathname: path,
          operations: ["put"],
          validUntil,
          allowedContentTypes: UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
        });
        return {
          token,
          urlOptions: {
            validUntil,
            allowedContentTypes: UPLOAD_CONTENT_TYPES,
            maximumSizeInBytes: MAX_UPLOAD_BYTES,
          },
        };
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Upload-URL aanmaken mislukt");
  }
}

/** Lokale modus: ruwe body → .data/media → publieke /api/media-URL. */
async function localUpload(req: Request) {
  if (useBlob || process.env.VERCEL) {
    return bad("Lokale upload is uitgeschakeld op deze server", 403);
  }
  const mime = normalizeMime(req.headers.get("content-type"));
  if (!UPLOAD_MIME[mime]) {
    return bad("Bestandstype niet toegestaan (alleen JPG, PNG, MP4 of MOV)");
  }
  const len = Number(req.headers.get("content-length") || "0");
  if (len > MAX_UPLOAD_BYTES) return bad("Bestand te groot (max 500 MB)", 413);
  if (!req.body) return bad("Leeg bestand");
  try {
    const id = await saveLocalStream(req.body, mime);
    return NextResponse.json({ url: `${APP_URL}/api/media/${id}` });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Opslaan mislukt");
  }
}
