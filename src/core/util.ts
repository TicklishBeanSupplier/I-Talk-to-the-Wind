export function newId(prefix = ""): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

export const nowIso = () => new Date().toISOString();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Call `check` until it returns a value, or give up after `timeoutMs`. */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  { intervalMs, timeoutMs, onTick }: { intervalMs: number; timeoutMs: number; onTick?: (elapsed: number) => void },
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) throw new Error("Timed out waiting for the platform to finish processing.");
    onTick?.(elapsed);
    await sleep(intervalMs);
  }
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const IMAGE_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff", gif: "image/gif",
};
const VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
};

export function mediaTypeFromName(name: string): { kind: "image" | "video"; mime: string } | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT[ext]) return { kind: "image", mime: IMAGE_EXT[ext] };
  if (VIDEO_EXT[ext]) return { kind: "video", mime: VIDEO_EXT[ext] };
  return null;
}

/** Files that are still being written or are system junk. */
export function isIgnorableFile(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~") || /\.(part|tmp|crdownload|download)$/i.test(name);
}

/** Run `fn` over `items` with at most `limit` running at once, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Like mapLimit, but a failing item is skipped instead of failing the whole batch. */
export async function mapLimitSettled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const settled = await mapLimit(items, limit, async (item) => {
    try {
      return { ok: true as const, value: await fn(item) };
    } catch {
      return { ok: false as const };
    }
  });
  return settled.flatMap((s) => (s.ok ? [s.value] : []));
}

export const addHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3_600_000).toISOString();
export const daysAgo = (days: number, now = new Date()) => new Date(now.getTime() - days * 86_400_000);
export const randomToken = (bytes = 16) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
