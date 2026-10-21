import { captionFor, titleFromCaption } from "../../core/captions";
import { result } from "../../core/drafts";
import type {
  Draft, InboxItem, MediaFile, MetaAccount, Page, PersonProfile, PersonRef, PostStats, PublishResult, RemotePost, TheirPost,
} from "../../core/types";
import { addHours, daysAgo, mapLimitSettled, pollUntil, truncate } from "../../core/util";
import type { FetchFn } from "../../runtime/types";
import type { StagedFile, SupabaseStaging } from "../staging/supabase";
import type { Capabilities, MediaReader, PlatformAdapter, PublishOptions } from "../types";
import { inboxId, PlatformError } from "../types";
import { type GraphClient, ruploadBytes } from "./graph";
import { fetchConversations, PRIVATE_REPLY_DAYS, sendPrivateReply, sendText } from "./messaging";

export interface MetaDeps {
  fetchFn: FetchFn;
  graph: GraphClient;
  account: MetaAccount;
  media: MediaReader;
  /** Null when the photo hand-off isn't set up. */
  staging: () => Promise<SupabaseStaging | null>;
}

interface RawMedia {
  id: string;
  caption?: string;
  timestamp: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_product_type?: "FEED" | "REELS" | "STORY" | "AD";
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

interface RawComment {
  id: string;
  text: string;
  username?: string;
  timestamp: string;
  from?: { id: string; username?: string };
  replies?: { data: RawComment[] };
}

const MEDIA_FIELDS =
  "id,caption,timestamp,media_type,media_product_type,media_url,thumbnail_url,permalink,like_count,comments_count";
const COMMENT_FIELDS = "id,text,username,timestamp,from{id,username},replies{id,text,username,timestamp}";
const PROFILE_FIELDS = "username,name,biography,followers_count,media_count,profile_picture_url";
const THEIR_MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,like_count,comments_count,permalink,timestamp";

export class InstagramAdapter implements PlatformAdapter {
  readonly id = "instagram" as const;
  readonly capabilities: Capabilities = { nativeScheduling: false, dms: true, sendPost: true, follow: false, reactors: false };

  private readonly igId: string;

  constructor(private readonly deps: MetaDeps) {
    if (!deps.account.instagramUserId)
      throw new PlatformError("No Instagram account is linked to your Facebook Page.", "instagram", undefined, true);
    this.igId = deps.account.instagramUserId;
  }

  private get me(): string {
    return (this.deps.account.instagramUsername ?? "").toLowerCase();
  }

  // ---------- Publishing ----------

  async publish(draft: Draft, opts: PublishOptions): Promise<PublishResult> {
    const { format, shareToFeed } = draft.targets.instagram;
    const caption = captionFor(draft, "instagram");
    const staged: StagedFile[] = [];
    const progress = (p: number, state: PublishResult["state"] = "uploading") => opts.onProgress({ state, progress: p });

    try {
      let containerId: string;
      const first = draft.media[0];
      if (!first) throw new PlatformError("Nothing to post.", "instagram");

      if (format === "carousel") {
        const children: string[] = [];
        for (const [i, m] of draft.media.entries()) {
          const child =
            m.kind === "video"
              ? await this.videoContainer(m, { media_type: "VIDEO", is_carousel_item: true })
              : await this.imageContainer(m, { is_carousel_item: true }, staged);
          await this.waitReady(child);
          children.push(child);
          progress(((i + 1) / draft.media.length) * 0.7);
        }
        containerId = (await this.deps.graph.post<{ id: string }>(`${this.igId}/media`, {
          media_type: "CAROUSEL", children: children.join(","), caption,
        })).id;
      } else if (format === "reel") {
        if (first.kind !== "video") throw new PlatformError("A Reel needs a video.", "instagram");
        containerId = await this.videoContainer(first, { media_type: "REELS", caption, share_to_feed: shareToFeed });
      } else if (format === "story") {
        containerId = first.kind === "video"
          ? await this.videoContainer(first, { media_type: "STORIES" })
          : await this.imageContainer(first, { media_type: "STORIES" }, staged);
      } else {
        if (first.kind !== "image") throw new PlatformError("Instagram posts videos as Reels.", "instagram");
        containerId = await this.imageContainer(first, { caption }, staged);
      }

      progress(0.75, "processing");
      await this.waitReady(containerId, (f) => progress(0.75 + f * 0.2, "processing"));
      const { id } = await this.deps.graph.post<{ id: string }>(`${this.igId}/media_publish`, { creation_id: containerId });
      const { permalink } = await this.deps.graph.get<{ permalink?: string }>(id, { fields: "permalink" }).catch(() => ({ permalink: undefined }));
      return result("published", { remoteId: id, permalink, progress: 1 });
    } finally {
      await Promise.all(staged.map((s) => s.remove()));
    }
  }

  private async imageContainer(m: MediaFile, params: Record<string, string | boolean>, staged: StagedFile[]): Promise<string> {
    const staging = await this.deps.staging();
    if (!staging)
      throw new PlatformError("Instagram photos need the Supabase hand-off. Set it up in Settings.", "instagram");
    const file = await staging.put(await this.deps.media.jpeg(m), "image/jpeg");
    staged.push(file);
    return (await this.deps.graph.post<{ id: string }>(`${this.igId}/media`, { image_url: file.url, ...params })).id;
  }

  private async videoContainer(m: MediaFile, params: Record<string, string | boolean>): Promise<string> {
    const { graph, fetchFn, media } = this.deps;
    const c = await graph.post<{ id: string; uri?: string }>(`${this.igId}/media`, { upload_type: "resumable", ...params });
    const uploadUrl = c.uri ?? `https://rupload.facebook.com/ig-api-upload/${graph.version}/${c.id}`;
    await ruploadBytes(fetchFn, uploadUrl, await graph.accessToken(), await media.bytes(m), "instagram");
    return c.id;
  }

  /** Wait until Instagram has finished processing a container. */
  private async waitReady(containerId: string, onTick?: (fraction: number) => void): Promise<void> {
    const timeoutMs = 15 * 60_000;
    await pollUntil(
      async () => {
        const s = await this.deps.graph.get<{ status_code?: string; status?: string }>(containerId, { fields: "status_code,status" });
        if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return true;
        if (s.status_code === "ERROR" || s.status_code === "EXPIRED")
          throw new PlatformError(`Instagram couldn't process this file. ${s.status ?? ""}`.trim(), "instagram", s);
        return undefined;
      },
      { intervalMs: 3000, timeoutMs, onTick: (elapsed) => onTick?.(Math.min(elapsed / (3 * 60_000), 1)) },
    );
  }

  // ---------- Inbox ----------

  async fetchInbox({ lookbackDays }: { lookbackDays: number }): Promise<InboxItem[]> {
    const [comments, dms] = await Promise.all([this.fetchComments(lookbackDays), fetchConversations(this.deps.graph, this.deps.account, "instagram", lookbackDays)]);
    return [...comments, ...dms];
  }

  private async fetchComments(lookbackDays: number): Promise<InboxItem[]> {
    const cutoff = daysAgo(lookbackDays).getTime();
    const media = (await this.recentMedia(25)).filter((m) => (m.comments_count ?? 0) > 0 && new Date(m.timestamp).getTime() >= cutoff);
    const perPost = await mapLimitSettled(media, 4, async (m) => {
      const comments = await this.deps.graph.getAll<RawComment>(`${m.id}/comments`, { fields: COMMENT_FIELDS, limit: 50 }, 2);
      return comments.filter((c) => !this.isMe(c.username)).map((c) => this.toInboxComment(c, m));
    });
    return perPost.flat();
  }

  private toInboxComment(c: RawComment, m: RawMedia): InboxItem {
    const username = c.username ?? c.from?.username;
    return {
      id: inboxId("instagram", "comment", c.id),
      platform: "instagram",
      kind: "comment",
      remoteId: c.id,
      person: { platform: "instagram", id: c.from?.id, username, name: username ?? "Instagram user" },
      text: c.text,
      at: c.timestamp,
      context: { postId: m.id, postTitle: postTitle(m.caption), thumbUrl: m.thumbnail_url ?? m.media_url },
      thread: (c.replies?.data ?? [])
        .map((r) => ({ id: r.id, text: r.text, at: r.timestamp, fromMe: this.isMe(r.username) }))
        .sort((a, b) => a.at.localeCompare(b.at)),
      status: "open",
      privateReplyUntil: addHours(c.timestamp, PRIVATE_REPLY_DAYS * 24),
    };
  }

  private isMe(username?: string): boolean {
    return !!username && !!this.me && username.toLowerCase() === this.me;
  }

  async reply(item: InboxItem, text: string): Promise<void> {
    if (item.kind === "comment") await this.deps.graph.post(`${item.remoteId}/replies`, { message: text });
    else await sendText(this.deps.graph, this.deps.account, item.person, text);
  }

  async privateReply(item: InboxItem, text: string): Promise<void> {
    await sendPrivateReply(this.deps.graph, this.deps.account, item.remoteId, text);
  }

  async hide(item: InboxItem): Promise<void> {
    if (item.kind !== "comment") throw new PlatformError("Only comments can be hidden.", "instagram");
    await this.deps.graph.post(item.remoteId, { hide: true });
  }

  // ---------- Your work ----------

  private recentMedia(limit: number): Promise<RawMedia[]> {
    return this.deps.graph.get<{ data: RawMedia[] }>(`${this.igId}/media`, { fields: MEDIA_FIELDS, limit }).then((r) => r.data);
  }

  async listMyPosts(limit: number): Promise<RemotePost[]> {
    return (await this.recentMedia(limit)).map((m) => ({
      platform: "instagram",
      remoteId: m.id,
      caption: m.caption ?? "",
      thumbUrl: m.thumbnail_url ?? m.media_url,
      permalink: m.permalink,
      at: m.timestamp,
      kind: m.media_product_type === "STORY" ? "story" : m.media_type === "VIDEO" ? "video" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "image",
      stats: { likes: m.like_count, comments: m.comments_count },
    }));
  }

  async postDetail(post: RemotePost) {
    const { graph } = this.deps;
    const [fresh, comments, saves] = await Promise.all([
      graph.get<RawMedia>(post.remoteId, { fields: "like_count,comments_count" }).catch(() => undefined),
      graph.getAll<RawComment>(`${post.remoteId}/comments`, { fields: "id,text,username,timestamp,from{id,username}", limit: 50 }, 3),
      // Saves need the insights permission; missing it just hides the number.
      graph
        .get<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(`${post.remoteId}/insights`, { metric: "saved" })
        .then((r) => r.data[0]?.total_value?.value ?? r.data[0]?.values?.[0]?.value)
        .catch(() => undefined),
    ]);
    const stats: PostStats = { ...post.stats, likes: fresh?.like_count ?? post.stats.likes, comments: fresh?.comments_count ?? post.stats.comments, saves };
    const commenters = comments
      .filter((c) => !this.isMe(c.username))
      .map((c) => ({
        person: { platform: "instagram" as const, id: c.from?.id, username: c.username, name: c.username ?? "Instagram user" },
        text: c.text,
        at: c.timestamp,
      }));
    return { stats, people: { commenters } };
  }

  // ---------- People ----------

  async profile(person: PersonRef): Promise<PersonProfile> {
    const { graph } = this.deps;
    const profile: PersonProfile = {
      ...person,
      postsVisible: false,
      profileUrl: person.username ? `https://www.instagram.com/${encodeURIComponent(person.username)}/` : undefined,
    };

    // People who messaged you: the messaging profile says who follows whom.
    if (person.id) {
      const p = await graph
        .get<{ name?: string; username?: string; profile_pic?: string; follower_count?: number; is_user_follow_business?: boolean; is_business_follow_user?: boolean }>(
          person.id,
          { fields: "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user" },
        )
        .catch(() => undefined);
      if (p) {
        Object.assign(profile, {
          name: p.name ?? profile.name,
          username: p.username ?? profile.username,
          avatarUrl: p.profile_pic,
          followers: p.follower_count,
          followsYou: p.is_user_follow_business,
          youFollow: p.is_business_follow_user,
        });
        if (p.username) profile.profileUrl = `https://www.instagram.com/${encodeURIComponent(p.username)}/`;
      }
    }

    // Creator and business accounts are public to Business Discovery.
    if (profile.username) {
      const d = await graph
        .get<{ business_discovery?: { username: string; name?: string; biography?: string; followers_count?: number; media_count?: number; profile_picture_url?: string } }>(
          this.igId,
          { fields: `business_discovery.username(${profile.username}){${PROFILE_FIELDS}}` },
        )
        .then((r) => r.business_discovery)
        .catch(() => undefined);
      if (d) {
        Object.assign(profile, {
          name: d.name || profile.name,
          bio: d.biography,
          followers: d.followers_count ?? profile.followers,
          postsCount: d.media_count,
          avatarUrl: d.profile_picture_url ?? profile.avatarUrl,
          postsVisible: true,
        });
      }
    }
    return profile;
  }

  async theirPosts(person: PersonProfile, cursor?: string): Promise<Page<TheirPost>> {
    if (!person.username || !person.postsVisible) return { items: [] };
    const media = `media.limit(8)${cursor ? `.after(${cursor})` : ""}{${THEIR_MEDIA_FIELDS}}`;
    const r = await this.deps.graph.get<{
      business_discovery?: { media?: { data: RawMedia[]; paging?: { cursors?: { after?: string }; next?: string } } };
    }>(this.igId, { fields: `business_discovery.username(${person.username}){${media}}` });
    const page = r.business_discovery?.media;
    return {
      items: (page?.data ?? []).map((m) => ({
        id: m.id,
        thumbUrl: m.thumbnail_url ?? m.media_url,
        caption: m.caption,
        kind: m.media_type === "VIDEO" ? "video" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "image",
        likes: m.like_count,
        comments: m.comments_count,
        permalink: m.permalink,
        at: m.timestamp,
      })),
      cursor: page?.paging?.next ? page.paging.cursors?.after : undefined,
    };
  }

  async sendMessage(to: PersonRef, text: string): Promise<void> {
    await sendText(this.deps.graph, this.deps.account, to, text);
  }

  async sendPost(to: PersonRef, post: RemotePost, note: string): Promise<void> {
    if (!to.id) throw new PlatformError("Can't message this person: no conversation with them yet.", "instagram");
    if (note.trim()) await sendText(this.deps.graph, this.deps.account, to, note.trim());
    await this.deps.graph.postJson(`${this.deps.account.pageId}/messages`, {
      recipient: { id: to.id },
      message: { attachment: { type: "MEDIA_SHARE", payload: { id: post.remoteId } } },
    });
  }
}

function postTitle(caption?: string): string {
  return truncate(titleFromCaption(caption ?? "", "your post"), 48);
}
