import { describe, expect, it } from "vitest";
import { newDraft } from "../core/drafts";
import type { InboxItem, MediaFile } from "../core/types";
import { DEFAULT_SETTINGS } from "../core/types";
import { FacebookAdapter } from "./meta/facebook";
import { GraphClient, toPlatformError } from "./meta/graph";
import { InstagramAdapter, type MetaDeps } from "./meta/instagram";
import { SupabaseStaging } from "./staging/supabase";
import { FakeNet, fakeMedia } from "./testing";
import { GoogleAuth } from "./youtube/auth";
import { nextOffset, YouTubeAdapter } from "./youtube/youtube";

const V = "v24.0";
const account = { pageId: "PAGE", pageName: "Page", instagramUserId: "IG", instagramUsername: "me.rides", connectedAt: "" };

function meta(net: FakeNet, withStaging = true): MetaDeps {
  return {
    fetchFn: net.fetch,
    graph: new GraphClient(net.fetch, V, async () => "TOKEN", "instagram"),
    account,
    media: fakeMedia,
    staging: async () => (withStaging ? new SupabaseStaging(net.fetch, "https://proj.supabase.co", "KEY", "bucket") : null),
  };
}

const photo: MediaFile = { id: "p", path: "/a.jpg", name: "a.jpg", kind: "image", mime: "image/jpeg", sizeBytes: 100, width: 1500, height: 1000 };
const clip: MediaFile = { id: "v", path: "/v.mp4", name: "v.mp4", kind: "video", mime: "video/mp4", sizeBytes: 20 * 1024 * 1024, width: 1080, height: 1920, durationSec: 30 };
const noop = () => undefined;

function supabaseRoutes(net: FakeNet) {
  net
    .on("POST", /supabase\.co\/storage\/v1\/object\/bucket\/handoff\//, { json: { Key: "k" } })
    .on("POST", /supabase\.co\/storage\/v1\/object\/sign\//, { json: { signedURL: "/object/sign/bucket/handoff/x.jpg?token=abc" } })
    .on("DELETE", /supabase\.co\/storage\/v1\/object\/bucket$/, { json: [] });
}

describe("Instagram", () => {
  it("publishes a photo through the hand-off and cleans up", async () => {
    const net = new FakeNet();
    supabaseRoutes(net);
    net
      .on("POST", /\/IG\/media$/, { json: { id: "C1" } })
      .on("GET", /\/C1\?/, { json: { status_code: "FINISHED" } })
      .on("POST", /\/IG\/media_publish$/, { json: { id: "M1" } })
      .on("GET", /\/M1\?/, { json: { permalink: "https://instagram.com/p/x" } });
    const d = newDraft([photo], DEFAULT_SETTINGS);
    d.caption = "Deep day";

    const r = await new InstagramAdapter(meta(net)).publish(d, { onProgress: noop });

    expect(r).toMatchObject({ state: "published", remoteId: "M1", permalink: "https://instagram.com/p/x" });
    const create = net.find("POST", /\/IG\/media$/)[0].body as Record<string, string>;
    expect(create.image_url).toBe("https://proj.supabase.co/storage/v1/object/sign/bucket/handoff/x.jpg?token=abc");
    expect(create.caption).toBe("Deep day");
    expect(net.find("DELETE", /supabase/)).toHaveLength(1);
  });

  it("explains when the photo hand-off isn't set up", async () => {
    const d = newDraft([photo], DEFAULT_SETTINGS);
    await expect(new InstagramAdapter(meta(new FakeNet(), false)).publish(d, { onProgress: noop })).rejects.toThrow(/Supabase/);
  });

  it("uploads a Reel with the resumable protocol", async () => {
    const net = new FakeNet()
      .on("POST", /\/IG\/media$/, { json: { id: "R1" } })
      .on("POST", /rupload\.facebook\.com\/ig-api-upload\/v24\.0\/R1$/, { json: { success: true } })
      .on("GET", /\/R1\?/, { json: { status_code: "FINISHED" } })
      .on("POST", /\/IG\/media_publish$/, { json: { id: "M2" } })
      .on("GET", /\/M2\?/, { json: {} });
    const d = newDraft([clip], DEFAULT_SETTINGS);
    const r = await new InstagramAdapter(meta(net)).publish(d, { onProgress: noop });

    expect(r.remoteId).toBe("M2");
    expect(net.find("POST", /\/IG\/media$/)[0].body).toMatchObject({ media_type: "REELS", upload_type: "resumable", share_to_feed: "true" });
    const up = net.find("POST", /rupload/)[0];
    expect(up.headers).toMatchObject({ authorization: "OAuth TOKEN", offset: "0", file_size: String(clip.sizeBytes) });
  });

  it("reports a processing error", async () => {
    const net = new FakeNet()
      .on("POST", /\/IG\/media$/, { json: { id: "R1" } })
      .on("POST", /rupload/, { json: { success: true } })
      .on("GET", /\/R1\?/, { json: { status_code: "ERROR", status: "Unsupported codec" } });
    const d = newDraft([clip], DEFAULT_SETTINGS);
    await expect(new InstagramAdapter(meta(net)).publish(d, { onProgress: noop })).rejects.toThrow(/Unsupported codec/);
  });

  it("builds the inbox from comments and DMs", async () => {
    const now = new Date().toISOString();
    const net = new FakeNet()
      .on("GET", /\/IG\/media\?/, { json: { data: [{ id: "M1", caption: "Deep day\n#pow", timestamp: now, media_type: "IMAGE", media_url: "u", comments_count: 2 }] } })
      .on("GET", /\/M1\/comments\?/, {
        json: {
          data: [
            { id: "c1", text: "What lens?", username: "maya.lens", timestamp: now, replies: { data: [] } },
            { id: "c2", text: "my own", username: "me.rides", timestamp: now },
          ],
        },
      })
      .on("GET", /\/PAGE\/conversations\?/, {
        json: {
          data: [{
            id: "T1", updated_time: now,
            participants: { data: [{ id: "IG", username: "me.rides" }, { id: "U1", username: "jordan" }] },
            messages: { data: [{ id: "m2", created_time: now, message: "Team edit?", from: { id: "U1" }, story: { reply_to: {} } }] },
          }],
        },
      });
    const items = await new InstagramAdapter(meta(net)).fetchInbox({ lookbackDays: 30 });

    expect(items).toHaveLength(2);
    const c = items.find((i) => i.kind === "comment")!;
    expect(c).toMatchObject({ remoteId: "c1", person: { username: "maya.lens" }, context: { postTitle: "Deep day" } });
    expect(c.privateReplyUntil).toBeDefined();
    const dm = items.find((i) => i.kind === "dm")!;
    expect(dm).toMatchObject({ person: { id: "U1", username: "jordan" }, text: "Team edit?", storyReply: true });
    expect(new Date(dm.replyWindowEndsAt!).getTime() - new Date(now).getTime()).toBe(24 * 3_600_000);
  });

  it("retries conversations without the story field when it's refused", async () => {
    const net = new FakeNet()
      .on("GET", /\/IG\/media\?/, { json: { data: [] } })
      .on("GET", /\/PAGE\/conversations\?.*story/, { status: 400, json: { error: { code: 100, message: "Unknown field" } } })
      .on("GET", /\/PAGE\/conversations\?/, { json: { data: [] } });
    await expect(new InstagramAdapter(meta(net)).fetchInbox({ lookbackDays: 30 })).resolves.toEqual([]);
    expect(net.find("GET", /conversations/)).toHaveLength(2);
  });

  it("sends a post as a media share, after the note", async () => {
    const net = new FakeNet().on("POST", /\/PAGE\/messages\?/, { json: { message_id: "x" } });
    await new InstagramAdapter(meta(net)).sendPost(
      { platform: "instagram", id: "U1", name: "J" },
      { platform: "instagram", remoteId: "M1", caption: "", at: "", kind: "image", stats: {} },
      "Here it is",
    );
    const sent = net.find("POST", /messages/).map((c) => c.body);
    expect(sent[0]).toMatchObject({ recipient: { id: "U1" }, message: { text: "Here it is" } });
    expect(sent[1]).toMatchObject({ message: { attachment: { type: "MEDIA_SHARE", payload: { id: "M1" } } } });
  });

  it("shows creator profiles with their posts, and falls back for personal ones", async () => {
    const net = new FakeNet()
      .on("GET", /business_discovery\.username\(creator\)\{username/, { json: { business_discovery: { username: "creator", biography: "Films", followers_count: 12400, media_count: 214 } } })
      .on("GET", /business_discovery\.username\(creator\)\{media/, {
        json: { business_discovery: { media: { data: [{ id: "X", media_type: "VIDEO", thumbnail_url: "t", like_count: 5, timestamp: "" }], paging: { cursors: { after: "CUR" }, next: "n" } } } },
      })
      .on("GET", /business_discovery\.username\(private\)/, { status: 400, json: { error: { code: 110, message: "not a business" } } });
    const ig = new InstagramAdapter(meta(net));

    const p = await ig.profile({ platform: "instagram", username: "creator", name: "creator" });
    expect(p).toMatchObject({ postsVisible: true, bio: "Films", followers: 12400, profileUrl: "https://www.instagram.com/creator/" });
    const page = await ig.theirPosts(p);
    expect(page).toMatchObject({ cursor: "CUR", items: [{ id: "X", kind: "video", likes: 5 }] });

    const priv = await ig.profile({ platform: "instagram", username: "private", name: "private" });
    expect(priv.postsVisible).toBe(false);
  });
});

describe("Facebook", () => {
  const fbDeps = (net: FakeNet): MetaDeps => ({ ...meta(net), graph: new GraphClient(net.fetch, V, async () => "TOKEN", "facebook") });

  it("schedules a single photo on the platform", async () => {
    const net = new FakeNet()
      .on("POST", /\/PAGE\/photos$/, { json: { id: "PH", post_id: "PAGE_1" } })
      .on("GET", /\/PAGE_1\?/, { json: { permalink_url: "https://fb.com/1" } });
    const d = newDraft([photo], DEFAULT_SETTINGS);
    d.caption = "Hi";
    const at = new Date(Date.now() + 3_600_000);
    const r = await new FacebookAdapter(fbDeps(net)).publish(d, { scheduleAt: at, onProgress: noop });

    expect(r).toMatchObject({ state: "scheduled", remoteId: "PAGE_1" });
    expect(net.find("POST", /photos/)[0].body).toMatchObject({
      message: "Hi", published: "false", scheduled_publish_time: String(Math.floor(at.getTime() / 1000)), source: "<blob 100>",
    });
  });

  it("uploads long video in chunks", async () => {
    const net = new FakeNet();
    let transfers = 0;
    net.on("POST", /graph-video\.facebook\.com\/v24\.0\/PAGE\/videos$/, (r) => {
      const b = r.body as Record<string, string>;
      if (b.upload_phase === "start") return { json: { upload_session_id: "S", video_id: "VID", start_offset: "0", end_offset: String(8 * 1024 * 1024) } };
      if (b.upload_phase === "transfer") {
        transfers++;
        const next = Math.min(Number(b.start_offset) + 8 * 1024 * 1024, clip.sizeBytes);
        return { json: { start_offset: String(next), end_offset: String(Math.min(next + 8 * 1024 * 1024, clip.sizeBytes)) } };
      }
      return { json: { success: true } };
    });
    const d = newDraft([clip], DEFAULT_SETTINGS);
    d.targets.facebook.format = "video";
    const r = await new FacebookAdapter(fbDeps(net)).publish(d, { onProgress: noop });
    expect(transfers).toBe(3); // 20 MiB in 8 MiB pieces
    expect(r).toMatchObject({ state: "published", remoteId: "VID" });
  });

  it("lists who reacted to a post", async () => {
    const net = new FakeNet()
      .on("GET", /\/P1\?fields=reactions/, { json: { reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 1 } }, shares: { count: 3 } } })
      .on("GET", /\/P1\/comments\?/, { json: { data: [{ id: "c", message: "Canada?", created_time: "t", from: { id: "U", name: "Dale" } }] } })
      .on("GET", /\/P1\/reactions\?/, { json: { data: [{ id: "A", name: "Ana" }, { id: "B", name: "Bo" }] } });
    const r = await new FacebookAdapter(fbDeps(net)).postDetail({ platform: "facebook", remoteId: "P1", caption: "", at: "", kind: "image", stats: {} });
    expect(r.stats).toMatchObject({ likes: 2, comments: 1, shares: 3 });
    expect(r.people.reactors?.map((p) => p.name)).toEqual(["Ana", "Bo"]);
    expect(r.people.commenters[0].person.name).toBe("Dale");
  });

  it("sends a private reply to a commenter", async () => {
    const net = new FakeNet().on("POST", /\/PAGE\/messages/, { json: {} });
    const item = { remoteId: "COMMENT1" } as InboxItem;
    await new FacebookAdapter(fbDeps(net)).privateReply(item, "Yes we ship");
    expect(net.calls[0].body).toEqual({ recipient: { comment_id: "COMMENT1" }, message: { text: "Yes we ship" } });
  });
});

describe("YouTube", () => {
  const ytAccount = { channelId: "MYCH", channelTitle: "Me", connectedAt: "" };
  const auth = { accessToken: async () => "GTOKEN" } as unknown as GoogleAuth;

  it("uploads in resumable chunks and notices the private lock", async () => {
    const net = new FakeNet()
      .on("POST", /upload\/youtube\/v3\/videos\?uploadType=resumable/, { headers: { Location: "https://upload.example/session" } })
      .on("PUT", /upload\.example\/session/, { status: 308, headers: { Range: "bytes=0-8388607" } }, 1)
      .on("PUT", /upload\.example\/session/, { status: 308, headers: { Range: "bytes=0-16777215" } }, 1)
      .on("PUT", /upload\.example\/session/, { json: { id: "VID", status: { privacyStatus: "private" } } });
    const d = newDraft([clip], DEFAULT_SETTINGS);
    d.targets.youtube.title = "Line breakdown";
    const r = await new YouTubeAdapter(net.fetch, auth, ytAccount, fakeMedia).publish(d, { onProgress: noop });

    expect(r).toMatchObject({ state: "published", remoteId: "VID", permalink: "https://youtu.be/VID" });
    expect(r.note).toMatch(/private/);
    const puts = net.find("PUT", /session/);
    expect(puts.map((p) => p.headers["content-range"])).toEqual([
      "bytes 0-8388607/20971520", "bytes 8388608-16777215/20971520", "bytes 16777216-20971519/20971520",
    ]);
    const init = net.find("POST", /uploadType=resumable/)[0];
    expect(init.body).toMatchObject({ snippet: { title: "Line breakdown" }, status: { privacyStatus: "public" } });
  });

  it("schedules as private with publishAt", async () => {
    const net = new FakeNet()
      .on("POST", /uploadType=resumable/, { headers: { Location: "https://upload.example/s" } })
      .on("PUT", /upload\.example\/s/, { json: { id: "V", status: { privacyStatus: "private" } } });
    const d = newDraft([{ ...clip, sizeBytes: 1000 }], DEFAULT_SETTINGS);
    const at = new Date(Date.now() + 86_400_000);
    const r = await new YouTubeAdapter(net.fetch, auth, ytAccount, fakeMedia).publish(d, { scheduleAt: at, onProgress: noop });
    expect(r.state).toBe("scheduled");
    expect(r.note).toBeUndefined();
    expect(net.calls[0].body).toMatchObject({ status: { privacyStatus: "private", publishAt: at.toISOString() } });
  });

  it("recovers from a server error mid-upload", async () => {
    const net = new FakeNet()
      .on("POST", /uploadType=resumable/, { headers: { Location: "https://upload.example/s" } })
      .on("PUT", /upload\.example\/s/, (r) =>
        r.headers["content-range"] === "bytes */1000" ? { status: 308, headers: { Range: "bytes=0-499" } } : { status: 503 }, 2)
      .on("PUT", /upload\.example\/s/, { json: { id: "V", status: { privacyStatus: "public" } } });
    const d = newDraft([{ ...clip, sizeBytes: 1000 }], DEFAULT_SETTINGS);
    const r = await new YouTubeAdapter(net.fetch, auth, ytAccount, fakeMedia).publish(d, { onProgress: noop });
    expect(r.remoteId).toBe("V");
    expect(net.find("PUT", /s$/).at(-1)?.headers["content-range"]).toBe("bytes 500-999/1000");
  }, 10_000);

  it("maps comment threads and skips your own", async () => {
    const now = new Date().toISOString();
    const snip = (ch: string, text: string) => ({ authorDisplayName: "@ana", authorChannelId: { value: ch }, textOriginal: text, publishedAt: now });
    const net = new FakeNet()
      .on("GET", /commentThreads\?/, {
        json: {
          items: [
            { id: "T1", snippet: { videoId: "V1", topLevelComment: { id: "T1", snippet: snip("ANA", "At 4:12?") } }, replies: { comments: [{ id: "r", snippet: snip("MYCH", "Yes") }] } },
            { id: "T2", snippet: { videoId: "V1", topLevelComment: { id: "T2", snippet: snip("MYCH", "pinned") } } },
          ],
        },
      })
      .on("GET", /\/videos\?/, { json: { items: [{ id: "V1", snippet: { title: "Tree run", thumbnails: { medium: { url: "m" } } } }] } });
    const items = await new YouTubeAdapter(net.fetch, auth, ytAccount, fakeMedia).fetchInbox({ lookbackDays: 30 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ person: { id: "ANA", name: "ana" }, context: { postTitle: "Tree run", thumbUrl: "m" } });
    expect(items[0].thread[0].fromMe).toBe(true);
  });

  it("parses resume ranges", () => {
    expect(nextOffset("bytes=0-99")).toBe(100);
    expect(nextOffset(null)).toBe(0);
  });
});

describe("Google login", () => {
  it("refreshes once even when asked many times at once", async () => {
    const store = new Map<string, string>([["google.clientId", "id"], ["google.clientSecret", "s"], ["google.refreshToken", "rt"]]);
    const secrets = { get: async (k: string) => store.get(k) ?? null, set: async () => undefined, delete: async () => undefined };
    const net = new FakeNet().on("POST", /oauth2\.googleapis\.com\/token/, { json: { access_token: "A", expires_in: 3600 } });
    const auth = new GoogleAuth(net.fetch, secrets);
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(tokens).toEqual(["A", "A", "A"]);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt" });
  });

  it("asks you to reconnect when the refresh token is revoked", async () => {
    const store = new Map<string, string>([["google.clientId", "id"], ["google.clientSecret", "s"], ["google.refreshToken", "rt"]]);
    const secrets = { get: async (k: string) => store.get(k) ?? null, set: async () => undefined, delete: async () => undefined };
    const net = new FakeNet().on("POST", /token/, { status: 400, json: { error: "invalid_grant" } });
    await expect(new GoogleAuth(net.fetch, secrets).accessToken()).rejects.toMatchObject({ needsReconnect: true });
  });
});

describe("Meta errors", () => {
  it("turns error codes into plain language", () => {
    expect(toPlatformError("facebook", 400, { error: { code: 190 } }).needsReconnect).toBe(true);
    expect(toPlatformError("facebook", 400, { error: { code: 10, error_subcode: 2018278 } }).message).toMatch(/24-hour/);
    expect(toPlatformError("facebook", 400, { error: { code: 4 } }).message).toMatch(/limiting/);
    expect(toPlatformError("facebook", 400, { error: { code: 1, message: "Odd" } }).message).toBe("Odd");
  });
});
