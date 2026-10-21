import { captionFor, countHashtags, countMentions, utf8Bytes } from "./captions";
import type { Draft, MediaFile, PlatformId } from "./types";

export type IssueLevel = "error" | "warning" | "info";

export interface Issue {
  level: IssueLevel;
  platform: PlatformId | "all";
  message: string;
}

// Limits as documented by Meta and Google. If a platform changes them,
// this is the one place to update.
export const LIMITS = {
  instagram: {
    captionChars: 2200,
    hashtags: 30,
    mentions: 20,
    imageMaxBytes: 8 * 1024 ** 2,
    minAspect: 4 / 5,
    maxAspect: 1.91,
    reelMinSec: 3,
    reelMaxSec: 15 * 60,
    storyVideoMaxSec: 60,
    carouselMin: 2,
    carouselMax: 10,
  },
  facebook: {
    captionChars: 63206,
    photosMax: 10,
    reelMinSec: 3,
    reelMaxSec: 90,
  },
  youtube: {
    titleChars: 100,
    descriptionBytes: 5000,
    tagsChars: 500,
    shortMaxSec: 180,
  },
} as const;

const aspect = (m: MediaFile) => (m.width && m.height ? m.width / m.height : undefined);
const isVertical = (m: MediaFile) => (aspect(m) ?? 1) < 0.9;

export function validateDraft(draft: Draft, now = new Date()): Issue[] {
  const issues: Issue[] = [];
  const add = (level: IssueLevel, platform: Issue["platform"], message: string) =>
    issues.push({ level, platform, message });

  const media = draft.media;
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  const t = draft.targets;

  if (media.length === 0) add("error", "all", "Add a photo or video.");
  if (!t.instagram.enabled && !t.facebook.enabled && !t.youtube.enabled)
    add("error", "all", "Pick at least one place to post.");

  if (draft.scheduledFor && new Date(draft.scheduledFor).getTime() < now.getTime() - 60_000)
    add("error", "all", "The scheduled time is in the past.");

  // ---------- Instagram ----------
  if (t.instagram.enabled && media.length) {
    const L = LIMITS.instagram;
    const cap = captionFor(draft, "instagram");
    const f = t.instagram.format;
    if (cap.length > L.captionChars) add("error", "instagram", `Caption is ${cap.length} characters; Instagram allows ${L.captionChars}.`);
    if (countHashtags(cap) > L.hashtags) add("error", "instagram", `Instagram allows ${L.hashtags} hashtags; this has ${countHashtags(cap)}.`);
    if (countMentions(cap) > L.mentions) add("error", "instagram", `Instagram allows ${L.mentions} @mentions.`);

    if (f === "carousel") {
      if (media.length < L.carouselMin || media.length > L.carouselMax)
        add("error", "instagram", `A carousel needs ${L.carouselMin}–${L.carouselMax} items.`);
    } else if (media.length > 1) {
      add("error", "instagram", "More than one file: switch Instagram to Carousel, or remove extras.");
    }
    if (f === "post" && videos.length) add("error", "instagram", "Instagram posts videos as Reels. Switch the format to Reel.");
    if (f === "reel") {
      if (!videos.length) add("error", "instagram", "A Reel needs a video.");
      for (const v of videos) {
        if (v.durationSec !== undefined && (v.durationSec < L.reelMinSec || v.durationSec > L.reelMaxSec))
          add("error", "instagram", `Reels must be between ${L.reelMinSec} seconds and ${L.reelMaxSec / 60} minutes.`);
        if (v.width && !isVertical(v)) add("warning", "instagram", "Reels look best vertical (9:16). This video isn't.");
      }
    }
    if (f === "story") {
      if (draft.caption.trim()) add("info", "instagram", "Stories don't show captions; Instagram will ignore it.");
      for (const v of videos)
        if (v.durationSec && v.durationSec > L.storyVideoMaxSec)
          add("warning", "instagram", `Story videos over ${L.storyVideoMaxSec}s may be rejected.`);
    }
    if (f === "post" || f === "carousel") {
      for (const img of images) {
        const a = aspect(img);
        if (a !== undefined && (a < L.minAspect - 0.01 || a > L.maxAspect + 0.01))
          add("error", "instagram", `"${img.name}" is ${describeAspect(a)}. Instagram feed photos must be between 4:5 (tall) and 1.91:1 (wide).`);
      }
    }
    for (const img of images) {
      if (img.mime !== "image/jpeg") add("info", "instagram", `"${img.name}" will be converted to JPEG (Instagram only takes JPEG).`);
      else if (img.sizeBytes > L.imageMaxBytes) add("warning", "instagram", `"${img.name}" is over 8 MB; Instagram may reject it.`);
    }
  }

  // ---------- Facebook ----------
  if (t.facebook.enabled && media.length) {
    const L = LIMITS.facebook;
    const f = t.facebook.format;
    const cap = captionFor(draft, "facebook");
    if (cap.length > L.captionChars) add("error", "facebook", "Caption is too long for Facebook.");
    if (f === "post") {
      if (videos.length) add("error", "facebook", "For video, switch Facebook to Reel or Video.");
      if (images.length > L.photosMax) add("error", "facebook", `Facebook posts take up to ${L.photosMax} photos.`);
    } else {
      if (videos.length !== 1 || images.length) add("error", "facebook", `A Facebook ${f === "reel" ? "Reel" : "video"} needs exactly one video.`);
      if (f === "reel")
        for (const v of videos) {
          if (v.durationSec !== undefined && (v.durationSec < L.reelMinSec || v.durationSec > L.reelMaxSec))
            add("error", "facebook", `Facebook Reels must be ${L.reelMinSec}–${L.reelMaxSec} seconds. Use Video instead.`);
          if (v.width && !isVertical(v)) add("warning", "facebook", "Facebook Reels should be vertical. Consider Video instead.");
        }
    }
  }

  // ---------- YouTube ----------
  if (t.youtube.enabled && media.length) {
    const L = LIMITS.youtube;
    const y = t.youtube;
    if (videos.length !== 1 || images.length) add("error", "youtube", "YouTube needs exactly one video.");
    if (!y.title.trim()) add("error", "youtube", "Add a YouTube title.");
    if (y.title.length > L.titleChars) add("error", "youtube", `YouTube titles max out at ${L.titleChars} characters.`);
    if (/[<>]/.test(y.title)) add("error", "youtube", "YouTube titles can't contain < or >.");
    const desc = captionFor(draft, "youtube");
    if (utf8Bytes(desc) > L.descriptionBytes) add("error", "youtube", "Description is too long for YouTube (5,000 bytes).");
    if (/[<>]/.test(desc)) add("error", "youtube", "YouTube descriptions can't contain < or >.");
    if (y.tags.join(",").length > L.tagsChars) add("error", "youtube", "Too many tags for YouTube (500 characters total).");
    const v = videos[0];
    if (v && v.durationSec !== undefined && v.durationSec <= L.shortMaxSec && isVertical(v))
      add("info", "youtube", "Vertical and under 3 minutes, so YouTube will treat it as a Short.");
  }

  return issues;
}

export const blocking = (issues: Issue[]) => issues.some((i) => i.level === "error");

function describeAspect(a: number): string {
  const known: [number, string][] = [[9 / 16, "9:16"], [4 / 5, "4:5"], [1, "1:1"], [16 / 9, "16:9"], [3 / 4, "3:4"], [2 / 3, "2:3"]];
  const hit = known.find(([v]) => Math.abs(v - a) < 0.02);
  return hit ? hit[1] : `${a.toFixed(2)}:1`;
}
