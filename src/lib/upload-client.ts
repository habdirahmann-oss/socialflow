/**
 * Browser-kant van de media-upload:
 * - bestand controleren + type afleiden,
 * - foto's omzetten naar JPEG (max 1440 px breed, kwaliteit 0.9),
 * - video-metadata (duur, breedte, hoogte) uitlezen,
 * - uploaden met voortgang: rechtstreeks naar Vercel Blob (presigned URL)
 *   of, lokaal zonder Blob, naar /api/upload?local=1.
 */

import { uploadPresigned } from "@vercel/blob/client";
import { httpErrorMessage, NETWORK_ERROR, postJson } from "./client-fetch";

export const ACCEPT =
  "image/jpeg,image/png,image/heic,video/mp4,video/quicktime";
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_WIDTH = 1440;
const JPEG_QUALITY = 0.9;

export const ERR_PHOTO_FORMAT =
  "Dit fotoformaat wordt niet ondersteund — exporteer als JPG of PNG";
export const ERR_FILE_TYPE =
  "Dit bestandstype wordt niet ondersteund — gebruik JPG, PNG, MP4 of MOV";
export const ERR_VIDEO_SIZE = "Deze video is te groot (max 500 MB)";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  webp: "image/webp",
  gif: "image/gif",
};

/** MIME-type; leeg file.type (komt voor bij .mov/.heic) → afleiden uit extensie. */
export function inferMime(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (t) return t === "image/jpg" ? "image/jpeg" : t;
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return EXT_MIME[ext] || "";
}

export interface PreparedMedia {
  /** Wat er geüpload wordt (foto's: altijd de JPEG-versie). */
  blob: Blob;
  mime: "image/jpeg" | "video/mp4" | "video/quicktime";
  ext: "jpg" | "mp4" | "mov";
  type: "image" | "video";
  previewUrl: string;
  width?: number;
  height?: number;
  duration?: number;
}

/** Decodeer een foto (createImageBitmap, anders via <img>). */
async function decodeImage(
  file: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // val terug op <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("decode");
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Foto → JPEG (Instagram accepteert alleen JPEG), max 1440 px breed. */
async function toJpeg(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch {
    throw new Error(ERR_PHOTO_FORMAT);
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_WIDTH / decoded.width);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(ERR_PHOTO_FORMAT);
    // Transparante PNG's: witte achtergrond i.p.v. zwart in JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) throw new Error(ERR_PHOTO_FORMAT);
    return { blob, width, height };
  } finally {
    decoded.close();
  }
}

/** Lees duur/breedte/hoogte uit een verborgen <video>. Faalt nooit hard. */
function readVideoMeta(
  url: string,
): Promise<{ width?: number; height?: number; duration?: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let done = false;
    const finish = (meta: { width?: number; height?: number; duration?: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(meta);
    };
    const timer = setTimeout(() => finish({}), 10_000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      finish({
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
      });
    v.onerror = () => finish({});
    v.src = url;
  });
}

/**
 * Controleer en bereid één bestand voor. Gooit een Error met een Nederlandse
 * melding als het bestand niet bruikbaar is (dan wordt er niets geüpload).
 */
export async function prepareMedia(file: File): Promise<PreparedMedia> {
  const mime = inferMime(file);

  if (mime.startsWith("image/")) {
    if (!["image/jpeg", "image/png", "image/heic", "image/heif"].includes(mime)) {
      throw new Error(ERR_PHOTO_FORMAT);
    }
    const { blob, width, height } = await toJpeg(file);
    return {
      blob,
      mime: "image/jpeg",
      ext: "jpg",
      type: "image",
      previewUrl: URL.createObjectURL(blob),
      width,
      height,
    };
  }

  if (mime === "video/mp4" || mime === "video/quicktime") {
    if (file.size > MAX_VIDEO_BYTES) throw new Error(ERR_VIDEO_SIZE);
    if (file.size === 0) throw new Error("Dit bestand is leeg");
    const previewUrl = URL.createObjectURL(file);
    const meta = await readVideoMeta(previewUrl);
    return {
      blob: file,
      mime,
      ext: mime === "video/mp4" ? "mp4" : "mov",
      type: "video",
      previewUrl,
      ...meta,
    };
  }

  throw new Error(ERR_FILE_TYPE);
}

/* ---------------- Upload ---------------- */

let modePromise: Promise<"blob" | "local"> | null = null;

/** 'blob' op Vercel, 'local' bij lokaal ontwikkelen zonder Blob. */
export function getUploadMode(): Promise<"blob" | "local"> {
  if (!modePromise) {
    modePromise = postJson<{ mode?: string }>("/api/upload", undefined, "GET")
      .then((d) => (d.mode === "local" ? "local" : "blob") as "blob" | "local")
      .catch((e) => {
        modePromise = null; // volgende keer opnieuw proberen
        throw e;
      });
  }
  return modePromise;
}

function localUpload(
  blob: Blob,
  mime: string,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload?local=1");
    xhr.setRequestHeader("content-type", mime);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => {
      let data: { url?: string; error?: string } | null = null;
      const isJson = (xhr.getResponseHeader("content-type") || "").includes(
        "application/json",
      );
      if (isJson) {
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.url) {
        resolve(data.url);
      } else {
        reject(new Error(httpErrorMessage(xhr.status, data?.error)));
      }
    };
    xhr.onerror = () => reject(new Error(NETWORK_ERROR));
    xhr.onabort = () => reject(new DOMException("Afgebroken", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * Upload het voorbereide bestand en geef de publieke URL terug.
 * Voortgang in procenten via onProgress.
 */
export async function uploadMedia(
  prepared: Pick<PreparedMedia, "blob" | "mime" | "ext">,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const mode = await getUploadMode();
  if (signal.aborted) throw new DOMException("Afgebroken", "AbortError");

  if (mode === "local") {
    return localUpload(prepared.blob, prepared.mime, onProgress, signal);
  }

  try {
    const result = await uploadPresigned(
      `media/${crypto.randomUUID()}.${prepared.ext}`,
      prepared.blob,
      {
        access: "public",
        handleUploadUrl: "/api/upload",
        contentType: prepared.mime,
        abortSignal: signal,
        onUploadProgress: (e) => onProgress(Math.round(e.percentage)),
      },
    );
    return result.url;
  } catch (e) {
    if (signal.aborted) throw new DOMException("Afgebroken", "AbortError");
    const msg = e instanceof Error ? e.message : "";
    throw new Error(
      `Upload mislukt — controleer je verbinding en probeer opnieuw${
        msg ? ` (${msg})` : ""
      }`,
    );
  }
}
