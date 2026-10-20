import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { put } from "@vercel/blob";
import { APP_URL } from "./config";

const MEDIA_DIR = path.join(process.cwd(), ".data", "media");

/**
 * Gebruik Vercel Blob zodra dat kan. Vercel koppelt Blob tegenwoordig via OIDC
 * (BLOB_STORE_ID + de deployment-identiteit) i.p.v. een vaste BLOB_READ_WRITE_TOKEN.
 * Op Vercel is de schijf alleen-lezen, dus daar nooit naar bestanden terugvallen.
 */
export const useBlob = Boolean(
  process.env.BLOB_READ_WRITE_TOKEN || // klassieke token
    process.env.BLOB_STORE_ID || // nieuwe OIDC-koppeling
    process.env.VERCEL, // draait op Vercel: schijf is read-only
);

/** Publieke basis-URL van de app (zonder slash op het eind); zie config.ts. */
export { APP_URL };

/** Toegestane uploadtypes → extensie. Instagram wil JPEG; PNG wordt client-side omgezet. */
export const UPLOAD_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};
export const UPLOAD_CONTENT_TYPES = Object.keys(UPLOAD_MIME);

/** Max. grootte voor directe browser-uploads (Blob of lokaal). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Max. gedecodeerde grootte van een (oude) data-URL in de request-body. */
export const MAX_DATAURL_BYTES = 4 * 1024 * 1024;

/** Enige toegestane pad-vorm voor uploads: media/<uuid>.<ext>. */
export const UPLOAD_PATH_RE = /^media\/[a-f0-9-]{36}\.(jpg|png|mp4|mov)$/;

/** Voor het teruglezen van lokaal opgeslagen bestanden (ook oudere extensies). */
const EXT: Record<string, string> = {
  ...UPLOAD_MIME,
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface SavedMedia {
  /** lokale bestandsnaam (alleen bij lokale opslag) */
  id: string;
  /** volledige publieke URL (alleen bij Vercel Blob) */
  url: string | null;
}

/** Normaliseert een content-type ('image/JPG; charset=x' → 'image/jpeg'). */
export function normalizeMime(raw: string | null | undefined): string {
  const mime = (raw || "").split(";")[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

/**
 * SSRF-bescherming: alleen media van onze eigen Blob-store of van onze eigen
 * /api/media-route mag naar Meta/TikTok/YouTube doorgestuurd worden.
 */
export function isAllowedMediaUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;

  if (
    url.protocol === "https:" &&
    url.hostname.endsWith(".public.blob.vercel-storage.com") &&
    (url.port === "" || url.port === "443")
  ) {
    return true;
  }

  const prefix = `${APP_URL}/api/media/`;
  if (!u.startsWith(prefix)) return false;
  // Na normalisatie moet het nog steeds precies /api/media/<bestand> zijn (geen ../).
  let app: URL;
  try {
    app = new URL(APP_URL);
  } catch {
    return false;
  }
  return (
    url.origin === app.origin &&
    /^\/api\/media\/[a-f0-9-]+\.[a-z0-9]+$/i.test(
      url.pathname.slice(app.pathname.replace(/\/+$/, "").length),
    )
  );
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) throw new Error("Ongeldige media (geen data-URL)");
  const mime = normalizeMime(match[1]);
  if (!UPLOAD_MIME[mime]) {
    throw new Error("Bestandstype niet toegestaan (alleen JPG, PNG, MP4 of MOV)");
  }
  // Grootte checken vóór het decoderen (base64: 4 tekens → 3 bytes).
  const b64 = match[2].replace(/\s+/g, "");
  if (Math.floor((b64.length * 3) / 4) > MAX_DATAURL_BYTES + 3) {
    throw new Error("Bestand te groot voor directe verzending (max 4 MB)");
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length > MAX_DATAURL_BYTES) {
    throw new Error("Bestand te groot voor directe verzending (max 4 MB)");
  }
  return { mime, buffer };
}

/** Alleen valideren (voor testmodus): gooit dezelfde fouten als saveDataUrl. */
export function validateDataUrl(dataUrl: string): void {
  parseDataUrl(dataUrl);
}

/** Sla media op en geef terug hoe je 'm publiek bereikt. */
export async function saveDataUrl(dataUrl: string): Promise<SavedMedia> {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const ext = UPLOAD_MIME[mime];

  if (useBlob) {
    const { url } = await put(`media/${randomUUID()}.${ext}`, buffer, {
      access: "public",
      contentType: mime,
    });
    return { id: "", url };
  }

  const id = `${randomUUID()}.${ext}`;
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.writeFile(path.join(MEDIA_DIR, id), buffer);
  return { id, url: null };
}

/**
 * Alleen lokale modus: schrijft een ruwe upload-stream naar .data/media.
 * Stopt (en ruimt op) zodra de stream groter wordt dan MAX_UPLOAD_BYTES.
 */
export async function saveLocalStream(
  body: ReadableStream<Uint8Array>,
  mime: string,
): Promise<string> {
  const ext = UPLOAD_MIME[normalizeMime(mime)];
  if (!ext) throw new Error("Bestandstype niet toegestaan");
  const id = `${randomUUID()}.${ext}`;
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, id);
  const handle = await fs.open(file, "w");
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        throw new Error("Bestand te groot (max 500 MB)");
      }
      await handle.write(value);
    }
    if (size === 0) throw new Error("Leeg bestand");
  } catch (e) {
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    await fs.unlink(file).catch(() => {});
    throw e;
  }
  await handle.close();
  return id;
}

/** Alleen voor lokale modus: leest een opgeslagen bestand terug. */
export async function readMedia(
  id: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(id)) return null;
  try {
    const buffer = await fs.readFile(path.join(MEDIA_DIR, id));
    const ext = id.split(".").pop() || "";
    const mime =
      Object.entries(EXT).find(([, e]) => e === ext)?.[0] ||
      "application/octet-stream";
    return { buffer, mime };
  } catch {
    return null;
  }
}
