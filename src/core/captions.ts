import type { Draft, PlatformId } from "./types";

/** The text that will actually go out on a platform. */
export function captionFor(draft: Draft, platform: PlatformId): string {
  const t = draft.targets;
  const override =
    platform === "instagram" ? t.instagram.captionOverride
    : platform === "facebook" ? t.facebook.captionOverride
    : t.youtube.descriptionOverride;
  return (override ?? draft.caption).trim();
}

export function hasOverride(draft: Draft, platform: PlatformId): boolean {
  const t = draft.targets;
  const v = platform === "instagram" ? t.instagram.captionOverride
    : platform === "facebook" ? t.facebook.captionOverride
    : t.youtube.descriptionOverride;
  return v !== undefined;
}

export const countHashtags = (s: string) => (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
export const countMentions = (s: string) => (s.match(/(^|\s)@[\w.]+/g) ?? []).length;
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** A YouTube title from a caption: first line, trimmed to 100 characters. */
export function titleFromCaption(caption: string, fallback: string): string {
  const first = caption.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const clean = first.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "").replace(/[<>]/g, "").trim();
  const t = clean || fallback;
  return t.length > 100 ? t.slice(0, 99).trimEnd() + "…" : t;
}

export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(v|ver|final|export)\s*\d*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
