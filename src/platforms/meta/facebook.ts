import { captionFor, titleFromCaption } from "../../core/captions";
import { result } from "../../core/drafts";
import type {
  Draft, InboxItem, MediaFile, Page, PersonProfile, PersonRef, PostStats, PublishResult, RemotePost, TheirPost,
} from "../../core/types";
import { addHours, daysAgo, mapLimitSettled, truncate } from "../../core/util";
import type { Capabilities, PlatformAdapter, PublishOptions } from "../types";
import { inboxId, PlatformError } from "../types";
import { ruploadBytes } from "./graph";
import type { MetaDeps } from "./instagram";
import { fetchConversations, PRIVATE_REPLY_DAYS, sendPrivateReply, sendText } from "./messaging";

interface RawPost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  attachments?: { data: { media_type?: string }[] };
  reactions?: { summary?: { total_count: number } };
  comments?: { summary?: { total_count: number } };
  shares?: { count: number };
}

interface RawComment {
  id: string;
  message: string;
  created_time: string;
  from?: { id: string; name: string };
  comments?: { data: RawComment[] };
}

const POST_FIELDS =
  "id,message,created_time,permalink_url,full_picture,attachments{media_type},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares";
const COMMENT_FIELDS = "id,message,created_time,from{id,name},comments{id,message,created_time,from{id,name}}";
/** Videos go up in pieces of this size, so a big file never sits in memory whole. */
const VIDEO_CHUNK = 8 * 1024 * 1024;

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export class FacebookAdapter implements PlatformAdapter {
  readonly id = "facebook" as const;
  readonly capabilities: Capabilities = { nativeScheduling: true, dms: true, sendPost: true, follow: false, reactors: true };

  constructor(private readonly deps: MetaDeps) {}

  private get pageId(): string {
    return this.deps.account.pageId;
  }

  // ---------- Publishing ----------

  async publish(draft: Draft, opts: PublishOptions): Promise<PublishResult> {
    const caption = captionFor(draft, "facebook");
    const { format } = draft.targets.facebook;
    const at = opts.scheduleAt;
    const done = (remoteId: string, permalink?: string) =>
      result(at ? "scheduled" : "published", { remoteId, permalink, progress: 1 });

    if (format === "post") {
      const photos = draft.media.filter((m) => m.kind === "image");
      if (!photos.length) throw new PlatformError("A Facebook post needs at least one photo.", "facebook");
      if (photos.length === 1) {
        const r = await this.uploadPhoto(photos[0], { message: caption, ...schedule(at) });
        opts.onProgress({ progress: 0.9 });
        const postId = r.post_id ?? r.id;
        return done(postId, await this.permalink(postId));
      }
      const ids: string[] = [];
      for (const [i, m] of photos.entries()) {
        ids.push((await this.uploadPhoto(m, { published: false, ...(at ? { temporary: true } : {}) })).id);
        opts.onProgress({ progress: ((i + 1) / photos.length) * 0.8 });
      }
      const params: Record<string, string | number | boolean> = { message: caption, ...schedule(at) };
      ids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      const { id } = await this.deps.graph.post<{ id: string }>(`${this.pageId}/feed`, params);
      return done(id, await this.permalink(id));
    }

    const video = draft.media.find((m) => m.kind === "video");
    if (!video) throw new PlatformError(`A Facebook ${format} needs a video.`, "facebook");
    return format === "reel" ? this.publishReel(video, caption, opts) : this.publishVideo(video, caption, opts);
  }

  private async uploadPhoto(m: MediaFile, params: Record<string, string | number | boolean>): Promise<{ id: string; post_id?: string }> {
    // Facebook takes JPEG and PNG directly; anything else is converted.
    const bytes = m.mime === "image/jpeg" || m.mime === "image/png" ? await this.deps.media.bytes(m) : await this.deps.media.jpeg(m);
    const type = m.mime === "image/png" ? "image/png" : "image/jpeg";
    const form = new FormData();
    form.set("source", new Blob([bytes as BlobPart], { type }), m.name);
    for (const [k, v] of Object.entries(params)) form.set(k, String(v));
    return this.deps.graph.postMultipart(`${this.pageId}/photos`, form);
  }

  private async publishReel(video: MediaFile, caption: string, opts: PublishOptions): Promise<PublishResult> {
    const { graph, fetchFn, media } = this.deps;
    const start = await graph.post<{ video_id: string; upload_url: string }>(`${this.pageId}/video_reels`, { upload_phase: "start" });
    await ruploadBytes(fetchFn, start.upload_url, await graph.accessToken(), await media.bytes(video), "facebook");
    opts.onProgress({ state: "processing", progress: 0.8 });
    await graph.post(`${this.pageId}/video_reels`, {
      upload_phase: "finish",
      video_id: start.video_id,
      description: caption,
      video_state: opts.scheduleAt ? "SCHEDULED" : "PUBLISHED",
      scheduled_publish_time: opts.scheduleAt ? unix(opts.scheduleAt) : undefined,
    });
    return result(opts.scheduleAt ? "scheduled" : "published", {
      remoteId: start.video_id,
      permalink: `https://www.facebook.com/reel/${start.video_id}`,
      progress: 1,
    });
  }

  /** Resumable upload in chunks, for long or large videos. */
  private async publishVideo(video: MediaFile, caption: string, opts: PublishOptions): Promise<PublishResult> {
    const { graph, media } = this.deps;
    const host = `https://graph-video.facebook.com/${graph.version}/${this.pageId}/videos`;
    const s = await graph.post<{ upload_session_id: string; video_id: string; start_offset: string; end_offset: string }>(host, {
      upload_phase: "start",
      file_size: video.sizeBytes,
    });

    let startOffset = Number(s.start_offset);
    let endOffset = Number(s.end_offset);
    while (startOffset < endOffset) {
      const chunk = await media.chunk(video, startOffset, Math.min(endOffset - startOffset, VIDEO_CHUNK));
      const form = new FormData();
      form.set("upload_phase", "transfer");
      form.set("upload_session_id", s.upload_session_id);
      form.set("start_offset", String(startOffset));
      form.set("video_file_chunk", new Blob([chunk as BlobPart]), video.name);
      const r = await graph.postMultipart<{ start_offset: string; end_offset: string }>(host, form);
      startOffset = Number(r.start_offset);
      endOffset = Number(r.end_offset);
      opts.onProgress({ progress: Math.min(startOffset / video.sizeBytes, 1) * 0.85 });
    }

    opts.onProgress({ state: "processing", progress: 0.9 });
    await graph.post(host, {
      upload_phase: "finish",
      upload_session_id: s.upload_session_id,
      description: caption,
      ...schedule(opts.scheduleAt),
    });
    return result(opts.scheduleAt ? "scheduled" : "published", {
      remoteId: s.video_id,
      permalink: `https://www.facebook.com/${this.pageId}/videos/${s.video_id}`,
      progress: 1,
    });
  }

  private async permalink(id: string): Promise<string | undefined> {
    return this.deps.graph.get<{ permalink_url?: string }>(id, { fields: "permalink_url" }).then((r) => r.permalink_url).catch(() => undefined);
  }

  // ---------- Inbox ----------

  async fetchInbox({ lookbackDays }: { lookbackDays: number }): Promise<InboxItem[]> {
    const [comments, dms] = await Promise.all([this.fetchComments(lookbackDays), fetchConversations(this.deps.graph, this.deps.account, "facebook", lookbackDays)]);
    return [...comments, ...dms];
  }

  private async fetchComments(lookbackDays: number): Promise<InboxItem[]> {
    const since = daysAgo(lookbackDays);
    const posts = await this.deps.graph.get<{ data: RawPost[] }>(`${this.pageId}/published_posts`, {
      fields: "id,message,created_time,full_picture,comments.summary(total_count).limit(0)",
      since: unix(since),
      limit: 25,
    });
    const withComments = posts.data.filter((p) => (p.comments?.summary?.total_count ?? 1) > 0);
    const perPost = await mapLimitSettled(withComments, 4, async (p) => {
      const comments = await this.deps.graph.getAll<RawComment>(`${p.id}/comments`, {
        fields: COMMENT_FIELDS, filter: "toplevel", order: "reverse_chronological", limit: 50,
      }, 2);
      return comments.filter((c) => c.from?.id !== this.pageId).map((c) => this.toInboxComment(c, p));
    });
    return perPost.flat();
  }

  private toInboxComment(c: RawComment, p: RawPost): InboxItem {
    return {
      id: inboxId("facebook", "comment", c.id),
      platform: "facebook",
      kind: "comment",
      remoteId: c.id,
      // Without the user-content permission Meta omits who wrote it.
      person: { platform: "facebook", id: c.from?.id, name: c.from?.name ?? "Facebook user" },
      text: c.message,
      at: c.created_time,
      context: { postId: p.id, postTitle: truncate(titleFromCaption(p.message ?? "", "your post"), 48), thumbUrl: p.full_picture },
      thread: (c.comments?.data ?? [])
        .map((r) => ({ id: r.id, text: r.message, at: r.created_time, fromMe: r.from?.id === this.pageId }))
        .sort((a, b) => a.at.localeCompare(b.at)),
      status: "open",
      privateReplyUntil: addHours(c.created_time, PRIVATE_REPLY_DAYS * 24),
    };
  }

  async reply(item: InboxItem, text: string): Promise<void> {
    if (item.kind === "comment") await this.deps.graph.post(`${item.remoteId}/comments`, { message: text });
    else await sendText(this.deps.graph, this.deps.account, item.person, text);
  }

  async privateReply(item: InboxItem, text: string): Promise<void> {
    await sendPrivateReply(this.deps.graph, this.deps.account, item.remoteId, text);
  }

  async hide(item: InboxItem): Promise<void> {
    if (item.kind !== "comment") throw new PlatformError("Only comments can be hidden.", "facebook");
    await this.deps.graph.post(item.remoteId, { is_hidden: true });
  }

  // ---------- Your work ----------

  async listMyPosts(limit: number): Promise<RemotePost[]> {
    const r = await this.deps.graph.get<{ data: RawPost[] }>(`${this.pageId}/published_posts`, { fields: POST_FIELDS, limit });
    return r.data.map((p) => ({
      platform: "facebook",
      remoteId: p.id,
      caption: p.message ?? "",
      thumbUrl: p.full_picture,
      permalink: p.permalink_url,
      at: p.created_time,
      kind: p.attachments?.data[0]?.media_type === "video" ? "video" : p.attachments?.data[0]?.media_type === "album" ? "carousel" : "image",
      stats: toStats(p),
    }));
  }

  async postDetail(post: RemotePost) {
    const { graph } = this.deps;
    const [fresh, comments, reactions] = await Promise.all([
      graph.get<RawPost>(post.remoteId, { fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares" }).catch(() => undefined),
      graph.getAll<RawComment>(`${post.remoteId}/comments`, { fields: "id,message,created_time,from{id,name}", limit: 50 }, 3).catch(() => []),
      graph.getAll<{ id: string; name?: string }>(`${post.remoteId}/reactions`, { fields: "id,name", limit: 100 }, 3).catch(() => []),
    ]);
    const stats: PostStats = fresh ? { ...post.stats, ...toStats(fresh) } : post.stats;
    return {
      stats,
      people: {
        commenters: comments
          .filter((c) => c.from?.id !== this.pageId)
          .map((c) => ({ person: { platform: "facebook" as const, id: c.from?.id, name: c.from?.name ?? "Facebook user" }, text: c.message, at: c.created_time })),
        reactors: reactions.map((r) => ({ platform: "facebook" as const, id: r.id, name: r.name ?? "Facebook user" })),
      },
    };
  }

  // ---------- People ----------

  async profile(person: PersonRef): Promise<PersonProfile> {
    const profile: PersonProfile = { ...person, postsVisible: false };
    if (!person.id) return profile;
    // Works for people who messaged your Page (Page-scoped ids).
    const p = await this.deps.graph
      .get<{ first_name?: string; last_name?: string; name?: string; profile_pic?: string }>(person.id, { fields: "first_name,last_name,profile_pic" })
      .catch(() => undefined);
    if (p) {
      const name = [p.first_name, p.last_name].filter(Boolean).join(" ");
      if (name) profile.name = name;
      profile.avatarUrl = p.profile_pic;
    }
    return profile;
  }

  async theirPosts(): Promise<Page<TheirPost>> {
    // Facebook doesn't let apps read a person's posts.
    return { items: [] };
  }

  async sendMessage(to: PersonRef, text: string): Promise<void> {
    await sendText(this.deps.graph, this.deps.account, to, text);
  }

  async sendPost(to: PersonRef, post: RemotePost, note: string): Promise<void> {
    if (!post.permalink) throw new PlatformError("This post has no link to share yet.", "facebook");
    await sendText(this.deps.graph, this.deps.account, to, [note.trim(), post.permalink].filter(Boolean).join("\n"));
  }
}

function schedule(at?: Date): Record<string, string | number | boolean> {
  return at ? { published: false, scheduled_publish_time: unix(at) } : {};
}

function toStats(p: RawPost): PostStats {
  return {
    likes: p.reactions?.summary?.total_count,
    comments: p.comments?.summary?.total_count,
    shares: p.shares?.count ?? 0,
  };
}
