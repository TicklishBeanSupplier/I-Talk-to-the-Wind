import { captionFor } from "../../core/captions";
import { result } from "../../core/drafts";
import type {
  Draft, InboxItem, Page, PersonProfile, PersonRef, PostStats, PublishResult, RemotePost, TheirPost, YouTubeAccount,
} from "../../core/types";
import { daysAgo, sleep } from "../../core/util";
import type { FetchFn } from "../../runtime/types";
import type { Capabilities, MediaReader, PlatformAdapter, PublishOptions } from "../types";
import { inboxId, PlatformError } from "../types";
import type { GoogleAuth } from "./auth";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
/** Must be a multiple of 256 KiB. */
const CHUNK = 32 * 256 * 1024; // 8 MiB
const MAX_RETRIES = 4;
/** Sports. */
const CATEGORY_ID = "17";

interface Thumbs { default?: { url: string }; medium?: { url: string }; high?: { url: string } }

interface RawVideo {
  id: string;
  snippet?: { title: string; description: string; publishedAt: string; thumbnails?: Thumbs };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  status?: { privacyStatus?: string; uploadStatus?: string };
}

interface RawCommentSnippet {
  authorDisplayName: string;
  authorChannelId?: { value: string };
  textOriginal: string;
  publishedAt: string;
  videoId?: string;
}

interface RawThread {
  id: string;
  snippet: { videoId?: string; topLevelComment: { id: string; snippet: RawCommentSnippet } };
  replies?: { comments: { id: string; snippet: RawCommentSnippet }[] };
}

interface RawChannel {
  id: string;
  snippet?: { title: string; description?: string; customUrl?: string; thumbnails?: Thumbs };
  statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

const num = (s?: string) => (s === undefined ? undefined : Number(s));
const thumb = (t?: Thumbs) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url;

export class YouTubeAdapter implements PlatformAdapter {
  readonly id = "youtube" as const;
  readonly capabilities: Capabilities = { nativeScheduling: true, dms: false, sendPost: false, follow: true, reactors: false };
  private uploadsPlaylist?: string;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly auth: GoogleAuth,
    private readonly account: YouTubeAccount,
    private readonly media: MediaReader,
  ) {}

  // ---------- HTTP ----------

  private async call<T>(method: string, path: string, params: Record<string, string | number | boolean | undefined> = {}, body?: unknown): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${API}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetchFn(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${await this.auth.accessToken()}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
    if (!res.ok || json.error) throw this.toError(res.status, json.error);
    return json;
  }

  private toError(status: number, e?: { message?: string; errors?: { reason?: string }[] }): PlatformError {
    const reason = e?.errors?.[0]?.reason;
    if (status === 401) return new PlatformError("Your YouTube login has expired. Reconnect in Settings.", "youtube", e, true);
    if (reason === "quotaExceeded") return new PlatformError("YouTube's daily limit for this app is used up. It resets at midnight Pacific time.", "youtube", e);
    if (reason === "uploadLimitExceeded") return new PlatformError("YouTube's upload limit for your channel was reached. Try again tomorrow.", "youtube", e);
    if (reason === "commentsDisabled") return new PlatformError("Comments are turned off on this video.", "youtube", e);
    if (reason === "insufficientPermissions" || status === 403)
      return new PlatformError(e?.message ?? "YouTube refused this request.", "youtube", e, reason === "insufficientPermissions");
    return new PlatformError(e?.message ?? `YouTube request failed (${status}).`, "youtube", e);
  }

  // ---------- Publishing ----------

  async publish(draft: Draft, opts: PublishOptions): Promise<PublishResult> {
    const video = draft.media.find((m) => m.kind === "video");
    if (!video) throw new PlatformError("YouTube needs a video.", "youtube");
    const y = draft.targets.youtube;
    const scheduled = !!opts.scheduleAt;

    const metadata = {
      snippet: { title: y.title.trim(), description: captionFor(draft, "youtube"), tags: y.tags, categoryId: CATEGORY_ID },
      status: {
        // A scheduled video must be private until its publish time.
        privacyStatus: scheduled ? "private" : y.privacy,
        publishAt: opts.scheduleAt?.toISOString(),
        selfDeclaredMadeForKids: y.madeForKids,
      },
    };

    const init = await this.fetchFn(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.auth.accessToken()}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(video.sizeBytes),
        "X-Upload-Content-Type": video.mime,
      },
      body: JSON.stringify(metadata),
    });
    if (!init.ok) {
      const j = (await init.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
      throw this.toError(init.status, j.error);
    }
    const session = init.headers.get("Location");
    if (!session) throw new PlatformError("YouTube didn't start the upload. Please try again.", "youtube");

    const uploaded = await this.uploadChunks(session, video.sizeBytes, (offset, len) => this.media.chunk(video, offset, len), (f) =>
      opts.onProgress({ state: "uploading", progress: f * 0.95 }),
    );

    // Unaudited API projects get their uploads locked to private.
    const lockedPrivate = !scheduled && y.privacy !== "private" && uploaded.status?.privacyStatus === "private";
    return result(scheduled ? "scheduled" : "published", {
      remoteId: uploaded.id,
      permalink: `https://youtu.be/${uploaded.id}`,
      progress: 1,
      note: lockedPrivate
        ? "YouTube kept this private because the app's Google project isn't audited yet. Make it public in YouTube Studio."
        : undefined,
    });
  }

  /** Send the file in 8 MiB pieces, resuming after network hiccups. */
  private async uploadChunks(
    session: string,
    total: number,
    read: (offset: number, length: number) => Promise<Uint8Array>,
    onProgress: (fraction: number) => void,
  ): Promise<RawVideo> {
    let offset = 0;
    let failures = 0;
    while (offset < total) {
      const length = Math.min(CHUNK, total - offset);
      let res: Response;
      try {
        const bytes = await read(offset, length);
        res = await this.fetchFn(session, {
          method: "PUT",
          headers: { "Content-Range": `bytes ${offset}-${offset + length - 1}/${total}` },
          body: bytes as unknown as BodyInit,
        });
      } catch {
        res = new Response(null, { status: 599 });
      }

      if (res.status === 200 || res.status === 201) return (await res.json()) as RawVideo;
      if (res.status === 308) {
        offset = nextOffset(res.headers.get("Range"));
        failures = 0;
        onProgress(offset / total);
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        if (++failures > MAX_RETRIES) throw new PlatformError("The YouTube upload kept failing. Check your connection and try again.", "youtube");
        await sleep(1000 * 2 ** failures);
        offset = await this.resumeOffset(session, total);
        continue;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
      throw this.toError(res.status, j.error);
    }
    // The last chunk normally returns 200; if we got here the server has everything.
    const done = await this.fetchFn(session, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
    if (done.ok) return (await done.json()) as RawVideo;
    throw new PlatformError("YouTube didn't confirm the upload.", "youtube");
  }

  /** Ask YouTube how much of the file it already has. */
  private async resumeOffset(session: string, total: number): Promise<number> {
    try {
      const res = await this.fetchFn(session, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
      return res.status === 308 ? nextOffset(res.headers.get("Range")) : 0;
    } catch {
      return 0;
    }
  }

  // ---------- Inbox ----------

  async fetchInbox({ lookbackDays }: { lookbackDays: number }): Promise<InboxItem[]> {
    const cutoff = daysAgo(lookbackDays).getTime();
    const threads: RawThread[] = [];
    let pageToken: string | undefined;
    // Newest first; stop once we pass the lookback window.
    for (let page = 0; page < 4; page++) {
      const r = await this.call<{ items: RawThread[]; nextPageToken?: string }>("GET", "commentThreads", {
        part: "snippet,replies",
        allThreadsRelatedToChannelId: this.account.channelId,
        order: "time",
        maxResults: 50,
        pageToken,
      });
      const fresh = r.items.filter((t) => new Date(t.snippet.topLevelComment.snippet.publishedAt).getTime() >= cutoff);
      threads.push(...fresh);
      if (fresh.length < r.items.length || !r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }

    const theirs = threads.filter((t) => t.snippet.topLevelComment.snippet.authorChannelId?.value !== this.account.channelId);
    const videos = await this.videos([...new Set(theirs.map((t) => t.snippet.videoId).filter(Boolean) as string[])], "snippet");
    const byId = new Map(videos.map((v) => [v.id, v]));

    return theirs.map((t) => {
      const top = t.snippet.topLevelComment.snippet;
      const v = t.snippet.videoId ? byId.get(t.snippet.videoId) : undefined;
      return {
        id: inboxId("youtube", "comment", t.id),
        platform: "youtube",
        kind: "comment",
        remoteId: t.id,
        person: { platform: "youtube", id: top.authorChannelId?.value, name: top.authorDisplayName.replace(/^@/, "") },
        text: top.textOriginal,
        at: top.publishedAt,
        context: t.snippet.videoId ? { postId: t.snippet.videoId, postTitle: v?.snippet?.title, thumbUrl: thumb(v?.snippet?.thumbnails) } : undefined,
        thread: (t.replies?.comments ?? [])
          .map((c) => ({ id: c.id, text: c.snippet.textOriginal, at: c.snippet.publishedAt, fromMe: c.snippet.authorChannelId?.value === this.account.channelId }))
          .sort((a, b) => a.at.localeCompare(b.at)),
        status: "open" as const,
      };
    });
  }

  async reply(item: InboxItem, text: string): Promise<void> {
    await this.call("POST", "comments", { part: "snippet" }, { snippet: { parentId: item.remoteId, textOriginal: text } });
  }

  async hide(item: InboxItem): Promise<void> {
    await this.call("POST", "comments/setModerationStatus", { id: item.remoteId, moderationStatus: "heldForReview" });
  }

  // ---------- Your work ----------

  /** Look up videos by id, 50 at a time (one quota unit per call). */
  private async videos(ids: string[], part: string): Promise<RawVideo[]> {
    const out: RawVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.call<{ items: RawVideo[] }>("GET", "videos", { part, id: ids.slice(i, i + 50).join(","), maxResults: 50 });
      out.push(...r.items);
    }
    return out;
  }

  private async uploadsOf(channelId: string): Promise<string | undefined> {
    const r = await this.call<{ items: RawChannel[] }>("GET", "channels", { part: "contentDetails", id: channelId });
    return r.items[0]?.contentDetails?.relatedPlaylists?.uploads;
  }

  private async playlistVideos(playlistId: string, limit: number, pageToken?: string): Promise<{ videos: RawVideo[]; next?: string }> {
    const r = await this.call<{ items: { contentDetails: { videoId: string } }[]; nextPageToken?: string }>("GET", "playlistItems", {
      part: "contentDetails", playlistId, maxResults: limit, pageToken,
    });
    const videos = await this.videos(r.items.map((i) => i.contentDetails.videoId), "snippet,statistics");
    return { videos, next: r.nextPageToken };
  }

  async listMyPosts(limit: number): Promise<RemotePost[]> {
    this.uploadsPlaylist ??= await this.uploadsOf(this.account.channelId);
    if (!this.uploadsPlaylist) return [];
    const { videos } = await this.playlistVideos(this.uploadsPlaylist, Math.min(limit, 50));
    return videos.map((v) => ({
      platform: "youtube",
      remoteId: v.id,
      caption: v.snippet?.title ?? "",
      thumbUrl: thumb(v.snippet?.thumbnails),
      permalink: `https://youtu.be/${v.id}`,
      at: v.snippet?.publishedAt ?? new Date().toISOString(),
      kind: "video",
      stats: toStats(v),
    }));
  }

  async postDetail(post: RemotePost) {
    const [fresh, threads] = await Promise.all([
      this.videos([post.remoteId], "statistics").then((v) => v[0]),
      this.call<{ items: RawThread[] }>("GET", "commentThreads", { part: "snippet", videoId: post.remoteId, order: "time", maxResults: 100 })
        .then((r) => r.items)
        .catch(() => [] as RawThread[]),
    ]);
    const stats: PostStats = fresh ? toStats(fresh) : post.stats;
    return {
      stats,
      people: {
        commenters: threads
          .map((t) => t.snippet.topLevelComment.snippet)
          .filter((s) => s.authorChannelId?.value !== this.account.channelId)
          .map((s) => ({
            person: { platform: "youtube" as const, id: s.authorChannelId?.value, name: s.authorDisplayName.replace(/^@/, "") },
            text: s.textOriginal,
            at: s.publishedAt,
          })),
      },
    };
  }

  // ---------- People ----------

  async profile(person: PersonRef): Promise<PersonProfile> {
    if (!person.id) return { ...person, postsVisible: false };
    const [channel, subscribed] = await Promise.all([
      this.call<{ items: RawChannel[] }>("GET", "channels", { part: "snippet,statistics,contentDetails", id: person.id }).then((r) => r.items[0]),
      this.call<{ items: unknown[] }>("GET", "subscriptions", { part: "id", mine: true, forChannelId: person.id })
        .then((r) => r.items.length > 0)
        .catch(() => undefined),
    ]);
    if (!channel) return { ...person, postsVisible: false };
    return {
      ...person,
      name: channel.snippet?.title ?? person.name,
      username: channel.snippet?.customUrl?.replace(/^@/, ""),
      bio: channel.snippet?.description,
      avatarUrl: thumb(channel.snippet?.thumbnails),
      followers: channel.statistics?.hiddenSubscriberCount ? undefined : num(channel.statistics?.subscriberCount),
      postsCount: num(channel.statistics?.videoCount),
      youFollow: subscribed,
      postsVisible: !!channel.contentDetails?.relatedPlaylists?.uploads,
      profileUrl: `https://www.youtube.com/channel/${channel.id}`,
    };
  }

  async theirPosts(person: PersonProfile, cursor?: string): Promise<Page<TheirPost>> {
    if (!person.id) return { items: [] };
    const uploads = await this.uploadsOf(person.id);
    if (!uploads) return { items: [] };
    const { videos, next } = await this.playlistVideos(uploads, 8, cursor);
    return {
      items: videos.map((v) => ({
        id: v.id,
        thumbUrl: thumb(v.snippet?.thumbnails),
        caption: v.snippet?.title,
        kind: "video",
        likes: num(v.statistics?.likeCount),
        comments: num(v.statistics?.commentCount),
        views: num(v.statistics?.viewCount),
        permalink: `https://youtu.be/${v.id}`,
        at: v.snippet?.publishedAt,
      })),
      cursor: next,
    };
  }

  async follow(person: PersonRef): Promise<void> {
    if (!person.id) throw new PlatformError("Can't find this channel.", "youtube");
    await this.call("POST", "subscriptions", { part: "snippet" }, { snippet: { resourceId: { kind: "youtube#channel", channelId: person.id } } });
  }
}

/** "bytes=0-8388607" → 8388608 (the next byte YouTube wants). */
export function nextOffset(range: string | null): number {
  const m = range?.match(/bytes=\d+-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

function toStats(v: RawVideo): PostStats {
  return { likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount), views: num(v.statistics?.viewCount) };
}
