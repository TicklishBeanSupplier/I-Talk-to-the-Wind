import { describe, expect, it } from "vitest";
import { captionFor, countHashtags, titleFromCaption, titleFromFileName } from "./captions";
import { newDraft, overallStatus, result } from "./drafts";
import { canPrivateReply, canReply, historyWith, mergeInbox, samePerson } from "./inbox";
import { planPublish } from "./publish";
import { inboxCheckDue, nextCheckTime, platformsDueNow } from "./schedule";
import type { Draft, InboxItem, MediaFile, RemotePost } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { blocking, validateDraft } from "./validate";
import { groupWork } from "./work";
import type { PlatformAdapter } from "../platforms/types";

const img = (over: Partial<MediaFile> = {}): MediaFile => ({
  id: "m1", path: "/x/a.jpg", name: "bluebird_drop.jpg", kind: "image", mime: "image/jpeg",
  sizeBytes: 1_000_000, width: 1500, height: 1000, ...over,
});
const vid = (over: Partial<MediaFile> = {}): MediaFile => ({
  id: "v1", path: "/x/v.mp4", name: "first_chair_edit_v3.mp4", kind: "video", mime: "video/mp4",
  sizeBytes: 50_000_000, width: 1080, height: 1920, durationSec: 42, ...over,
});

describe("drafts", () => {
  it("picks formats from the media", () => {
    const v = newDraft([vid()], DEFAULT_SETTINGS);
    expect(v.targets.instagram.format).toBe("reel");
    expect(v.targets.facebook.format).toBe("reel");
    expect(v.targets.youtube.enabled).toBe(true);
    expect(v.targets.youtube.title).toBe("First chair edit");

    const p = newDraft([img()], DEFAULT_SETTINGS);
    expect(p.targets.instagram.format).toBe("post");
    expect(p.targets.facebook.format).toBe("post");
    expect(p.targets.youtube.enabled).toBe(false);

    const c = newDraft([img(), img({ id: "m2" })], DEFAULT_SETTINGS);
    expect(c.targets.instagram.format).toBe("carousel");

    const long = newDraft([vid({ width: 1920, height: 1080, durationSec: 600 })], DEFAULT_SETTINGS);
    expect(long.targets.facebook.format).toBe("video");
  });

  it("rolls up status", () => {
    const d = newDraft([img()], DEFAULT_SETTINGS);
    expect(overallStatus(d)).toBe("draft");
    d.results = { instagram: result("published"), facebook: result("failed") };
    expect(overallStatus(d)).toBe("partial");
    d.results.facebook = result("uploading");
    expect(overallStatus(d)).toBe("publishing");
    d.results.facebook = result("scheduled");
    expect(overallStatus(d)).toBe("scheduled");
    d.results.facebook = result("published");
    expect(overallStatus(d)).toBe("published");
  });
});

describe("captions", () => {
  it("uses overrides per platform", () => {
    const d = newDraft([img()], DEFAULT_SETTINGS);
    d.caption = "Base";
    d.targets.instagram.captionOverride = "IG only";
    expect(captionFor(d, "instagram")).toBe("IG only");
    expect(captionFor(d, "facebook")).toBe("Base");
  });
  it("counts hashtags and makes titles", () => {
    expect(countHashtags("a #one #two#not #três")).toBe(3);
    expect(titleFromCaption("\n Deep day #pow\nmore", "x")).toBe("Deep day");
    expect(titleFromCaption("#only #tags", "Fallback")).toBe("Fallback");
    expect(titleFromFileName("first_chair_edit_v3.mp4")).toBe("First chair edit");
  });
});

describe("validate", () => {
  it("accepts a normal photo post", () => {
    const d = newDraft([img()], DEFAULT_SETTINGS);
    expect(blocking(validateDraft(d))).toBe(false);
  });
  it("blocks a photo too tall for the Instagram feed", () => {
    const d = newDraft([img({ width: 1000, height: 2000 })], DEFAULT_SETTINGS);
    const issues = validateDraft(d);
    expect(issues.some((i) => i.platform === "instagram" && i.level === "error")).toBe(true);
  });
  it("blocks YouTube without a video and without a title", () => {
    const d = newDraft([vid()], DEFAULT_SETTINGS);
    d.targets.youtube.title = "  ";
    expect(validateDraft(d).some((i) => i.platform === "youtube" && i.message.includes("title"))).toBe(true);
  });
  it("flags past schedule and too many hashtags", () => {
    const d = newDraft([img()], DEFAULT_SETTINGS);
    d.scheduledFor = new Date(Date.now() - 3_600_000).toISOString();
    d.caption = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const msgs = validateDraft(d).map((i) => i.message).join("|");
    expect(msgs).toContain("past");
    expect(msgs).toContain("30 hashtags");
  });
  it("notes JPEG conversion instead of blocking", () => {
    const d = newDraft([img({ mime: "image/png", name: "a.png" })], DEFAULT_SETTINGS);
    const issues = validateDraft(d);
    expect(blocking(issues)).toBe(false);
    expect(issues.some((i) => i.message.includes("JPEG"))).toBe(true);
  });
});

describe("schedule", () => {
  it("finds the next inbox check", () => {
    const now = new Date(2026, 0, 10, 14, 5);
    expect(nextCheckTime(["09:00", "18:00", "13:00"], now)?.getHours()).toBe(18);
    const late = nextCheckTime(["09:00"], new Date(2026, 0, 10, 20, 0))!;
    expect(late.getDate()).toBe(11);
    expect(late.getHours()).toBe(9);
  });
  it("knows when a check is due", () => {
    const now = new Date(2026, 0, 10, 13, 30);
    expect(inboxCheckDue(["09:00", "13:00"], undefined, now)).toBe(true);
    expect(inboxCheckDue(["09:00", "13:00"], new Date(2026, 0, 10, 13, 10).toISOString(), now)).toBe(false);
    expect(inboxCheckDue(["09:00", "13:00"], new Date(2026, 0, 10, 12, 0).toISOString(), now)).toBe(true);
  });
  it("lists platforms the app must publish", () => {
    const d = newDraft([img()], DEFAULT_SETTINGS);
    d.scheduledFor = new Date(Date.now() - 1000).toISOString();
    d.results = { facebook: result("scheduled") };
    expect(platformsDueNow(d)).toEqual(["instagram"]);
  });
});

const fakeAdapter = (nativeScheduling: boolean) =>
  ({ capabilities: { nativeScheduling } }) as unknown as PlatformAdapter;

describe("planPublish", () => {
  const adapters = { instagram: fakeAdapter(false), facebook: fakeAdapter(true), youtube: fakeAdapter(true) };
  it("publishes everything now when not scheduled", () => {
    const d = newDraft([vid()], DEFAULT_SETTINGS);
    expect(planPublish(d, adapters, true)).toEqual({ now: ["instagram", "facebook", "youtube"], handOff: [], later: [] });
  });
  it("hands off to platforms that can schedule", () => {
    const now = new Date();
    const d = newDraft([vid()], DEFAULT_SETTINGS);
    d.scheduledFor = new Date(now.getTime() + 3 * 3_600_000).toISOString();
    expect(planPublish(d, adapters, true, now)).toEqual({ now: [], handOff: ["facebook", "youtube"], later: ["instagram"] });
    expect(planPublish(d, adapters, false, now).later).toEqual(["instagram", "facebook", "youtube"]);
  });
  it("keeps it local when the time is too close", () => {
    const now = new Date();
    const d = newDraft([vid()], DEFAULT_SETTINGS);
    d.scheduledFor = new Date(now.getTime() + 5 * 60_000).toISOString();
    expect(planPublish(d, adapters, true, now).handOff).toEqual([]);
  });
  it("skips finished and in-flight platforms, retries failed ones", () => {
    const d = newDraft([vid()], DEFAULT_SETTINGS);
    d.results = { instagram: result("published"), facebook: result("processing"), youtube: result("failed") };
    expect(planPublish(d, adapters, true).now).toEqual(["youtube"]);
  });
});

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "instagram:dm:c1", platform: "instagram", kind: "dm", remoteId: "c1",
  person: { platform: "instagram", id: "111", username: "jordan", name: "Jordan" },
  text: "hi", at: "2026-01-10T10:00:00Z", thread: [{ id: "a", text: "hi", at: "2026-01-10T10:00:00Z", fromMe: false }],
  status: "open", ...over,
});

describe("inbox", () => {
  it("adds new items open, and done if already answered", () => {
    const merged = mergeInbox([], [
      item({}),
      item({ id: "x", thread: [{ id: "a", text: "hi", at: "2026-01-10T10:00:00Z", fromMe: false }, { id: "b", text: "yo", at: "2026-01-10T11:00:00Z", fromMe: true }] }),
    ]);
    expect(merged.find((i) => i.id === "instagram:dm:c1")?.status).toBe("open");
    expect(merged.find((i) => i.id === "x")?.status).toBe("done");
  });
  it("reopens when they write again, keeps hidden hidden", () => {
    const done = item({ status: "done", resolvedAt: "2026-01-10T12:00:00Z" });
    const newer = item({ at: "2026-01-10T13:00:00Z", text: "again" });
    expect(mergeInbox([done], [newer])[0].status).toBe("open");
    const hidden = item({ status: "hidden" });
    expect(mergeInbox([hidden], [newer])[0].status).toBe("hidden");
  });
  it("keeps items that fell out of the fetch", () => {
    expect(mergeInbox([item({ id: "old" })], [])).toHaveLength(1);
  });
  it("respects reply windows", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    expect(canReply(item({ replyWindowEndsAt: "2026-01-10T11:00:00Z" }), now)).toBe(false);
    expect(canReply(item({ kind: "comment" }), now)).toBe(true);
    const c = item({ kind: "comment", privateReplyUntil: "2026-01-12T00:00:00Z" });
    expect(canPrivateReply(c, now)).toBe(true);
    expect(canPrivateReply({ ...c, privateReplySent: true }, now)).toBe(false);
  });
  it("matches people by username across ids", () => {
    const a = { platform: "instagram" as const, id: "1", username: "Jordan", name: "J" };
    const b = { platform: "instagram" as const, id: "2", username: "jordan", name: "Jordan R" };
    expect(samePerson(a, b)).toBe(true);
    expect(samePerson(a, { ...b, platform: "facebook" })).toBe(false);
  });
  it("summarises history with someone", () => {
    const items = [
      item({ storyReply: true }),
      item({ id: "c", kind: "comment", context: { postId: "p", postTitle: "Deep day" }, person: { platform: "instagram", id: "9", username: "jordan", name: "Jordan" } }),
    ];
    const h = historyWith(items, { platform: "instagram", username: "jordan", name: "Jordan" });
    expect(h).toMatchObject({ messages: 1, comments: 1, storyReplies: 1, lastCommentOn: "Deep day" });
  });
});

describe("groupWork", () => {
  it("groups app posts across platforms and keeps outside posts", () => {
    const d: Draft = newDraft([img()], DEFAULT_SETTINGS);
    d.caption = "Deep day\n#pow";
    d.publishedAt = "2026-01-10T10:00:00Z";
    d.results = { instagram: result("published", { remoteId: "ig1" }), facebook: result("published", { remoteId: "fb1" }) };
    const remote: RemotePost[] = [
      { platform: "instagram", remoteId: "ig1", caption: "Deep day", at: "2026-01-10T10:00:00Z", kind: "image", stats: { likes: 5 }, thumbUrl: "t" },
      { platform: "instagram", remoteId: "ig2", caption: "Older one", at: "2026-01-01T10:00:00Z", kind: "image", stats: {} },
    ];
    const w = groupWork([d], remote);
    expect(w).toHaveLength(2);
    expect(w[0].title).toBe("Deep day");
    expect(w[0].posts.map((p) => p.platform)).toEqual(["instagram", "facebook"]);
    expect(w[0].posts[0].stats.likes).toBe(5);
    expect(w[1].title).toBe("Older one");
  });
});
