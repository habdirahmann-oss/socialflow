import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { put } from "@vercel/blob";

const MEDIA_DIR = path.join(process.cwd(), ".data", "media");

/**
 * Gebruik Vercel Blob zodra dat kan. Vercel koppelt Blob tegenwoordig via OIDC
 * (BLOB_STORE_ID + de deployment-identiteit) i.p.v. een vaste BLOB_READ_WRITE_TOKEN.
 * Op Vercel is de schijf alleen-lezen, dus daar nooit naar bestanden terugvallen.
 */
const useBlob = Boolean(
  process.env.BLOB_READ_WRITE_TOKEN || // klassieke token
    process.env.BLOB_STORE_ID || // nieuwe OIDC-koppeling
    process.env.VERCEL, // draait op Vercel: schijf is read-only
);

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export interface SavedMedia {
  /** lokale bestandsnaam (alleen bij lokale opslag) */
  id: string;
  /** volledige publieke URL (alleen bij Vercel Blob) */
  url: string | null;
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) throw new Error("Ongeldige media (geen data-URL)");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

/** Sla media op en geef terug hoe je 'm publiek bereikt. */
export async function saveDataUrl(dataUrl: string): Promise<SavedMedia> {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const ext = EXT[mime] || "bin";

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
