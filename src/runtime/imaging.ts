// Image and video helpers that run inside the app's web view.
import type { MediaInfo } from "./types";

/** Read a video's size and length from its metadata only (no full load). */
export function probeVideo(url: string, timeoutMs = 15_000): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const finish = (info: MediaInfo) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(info);
    };
    const timer = setTimeout(() => finish({}), timeoutMs);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      finish({
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
        durationSec: Number.isFinite(v.duration) ? v.duration : undefined,
      });
    v.onerror = () => finish({});
    v.src = url;
  });
}

export function probeImage(url: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
    img.onerror = () => resolve({});
    img.src = url;
  });
}

/** Longest edge Instagram keeps; anything bigger is scaled down on their side anyway. */
const MAX_EDGE = 2160;

/**
 * Convert any image the web view can decode to JPEG. Already-JPEG files
 * pass through untouched so there's no quality loss.
 */
export async function toJpeg(bytes: Uint8Array, mime: string, quality = 0.92): Promise<Uint8Array> {
  if (mime === "image/jpeg") return bytes;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    throw new Error("This image format can't be converted here. Export it as JPEG from Lightroom or Photoshop.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't convert the image.");
  // JPEG has no transparency: paint white behind PNG cut-outs.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}
