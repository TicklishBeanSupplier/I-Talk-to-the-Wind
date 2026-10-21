import { titleFromFileName } from "./captions";
import type { Draft, DraftStatus, MediaFile, PlatformId, PublishResult, Settings } from "./types";
import { PLATFORMS } from "./types";
import { newId, nowIso } from "./util";

/** Pick sensible formats for whatever media was dropped in. */
export function newDraft(media: MediaFile[], settings: Pick<Settings, "defaultTargets">): Draft {
  const videos = media.filter((m) => m.kind === "video");
  const images = media.filter((m) => m.kind === "image");
  const singleVideo = videos.length === 1 && images.length === 0;
  const v = videos[0];
  const vertical = v?.width && v?.height ? v.width / v.height < 0.9 : true;
  const shortish = v?.durationSec === undefined || v.durationSec <= 90;
  const d = settings.defaultTargets;
  const now = nowIso();

  return {
    id: newId("d_"),
    createdAt: now,
    updatedAt: now,
    media,
    caption: "",
    status: "draft",
    results: {},
    scheduledFor: null,
    targets: {
      instagram: {
        enabled: d.instagram,
        format: media.length > 1 ? "carousel" : singleVideo ? "reel" : "post",
        shareToFeed: true,
      },
      facebook: {
        enabled: d.facebook,
        format: images.length && !videos.length ? "post" : singleVideo && vertical && shortish ? "reel" : "video",
      },
      youtube: {
        // YouTube only takes a single video.
        enabled: d.youtube && singleVideo,
        title: media[0] ? titleFromFileName(media[0].name) : "",
        privacy: "public",
        madeForKids: false,
        tags: [],
      },
    },
  };
}

export function enabledPlatforms(draft: Draft): PlatformId[] {
  return PLATFORMS.filter((p) => draft.targets[p].enabled);
}

/** Roll up per-platform results into one status for the draft. */
export function overallStatus(draft: Draft): DraftStatus {
  const targets = enabledPlatforms(draft);
  const results = targets.map((p) => draft.results[p]);
  if (results.every((r) => !r)) return draft.scheduledFor ? "scheduled" : "draft";
  const states = results.map((r) => r?.state ?? "waiting");
  if (states.some((s) => s === "uploading" || s === "processing")) return "publishing";
  const finished = (s: string) => s === "published" || s === "scheduled";
  if (states.every(finished)) return states.every((s) => s === "published") ? "published" : "scheduled";
  if (states.every((s) => s === "failed")) return "failed";
  if (states.some((s) => s === "failed")) return "partial";
  // Some platforms still waiting on the local scheduler.
  return "scheduled";
}

export function result(state: PublishResult["state"], extra: Partial<PublishResult> = {}): PublishResult {
  return { state, updatedAt: nowIso(), ...extra };
}
