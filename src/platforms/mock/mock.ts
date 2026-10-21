// Preview mode: believable platforms that live in memory. Nothing leaves the page.
import { captionFor } from "../../core/captions";
import { result } from "../../core/drafts";
import type {
  Draft, InboxItem, Page, PersonProfile, PersonRef, PlatformId, PostStats, PublishResult, RemotePost, TheirPost,
} from "../../core/types";
import { addHours, newId, sleep } from "../../core/util";
import type { Capabilities, PlatformAdapter, PublishOptions } from "../types";
import { inboxId, PlatformError } from "../types";
import { skateArt, snowArt } from "./art";

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

interface MockPerson extends PersonProfile {
  posts?: TheirPost[];
}

/** One shared fake world, so all three platforms agree with each other. */
class World {
  people: MockPerson[];
  posts: RemotePost[];
  inbox: InboxItem[];
  reactors: Record<string, PersonRef[]> = {};

  constructor() {
    const ig = (username: string, name: string, extra: Partial<MockPerson> = {}): MockPerson => ({
      platform: "instagram", id: `ig_${username}`, username, name, postsVisible: false,
      profileUrl: `https://www.instagram.com/${username}/`, ...extra,
    });
    const theirPosts = (seed: number, n: number): TheirPost[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `tp_${seed}_${i}`,
        thumbUrl: snowArt(seed * 31 + i, 400, 500),
        kind: i % 3 === 1 ? "video" : "image",
        likes: 300 + ((seed * 97 + i * 131) % 3000),
        comments: 5 + ((seed + i * 7) % 60),
        caption: "Out in it",
        at: ago(24 * (i + 1) * 3),
      }));

    this.people = [
      ig("maya.lens", "maya.lens", { followers: 3120, followsYou: true }),
      ig("jordanruiz.films", "Jordan Ruiz", {
        bio: "Filmmaker. Winter team edits, Tahoe and the Sierra.", followers: 12400, postsCount: 214,
        followsYou: true, youFollow: true, postsVisible: true, posts: theirPosts(7, 24),
      }),
      ig("sam.oduya", "Sam Oduya", { followers: 860, followsYou: true }),
      {
        platform: "youtube", id: "UC_ana", name: "Ana Kowalski", bio: "Splitboarder. Line breakdowns and avalanche courses.",
        followers: 41200, postsCount: 88, youFollow: false, postsVisible: true,
        profileUrl: "https://www.youtube.com/channel/UC_ana", posts: theirPosts(3, 16).map((p) => ({ ...p, kind: "video", views: (p.likes ?? 0) * 12 })),
      },
      { platform: "facebook", id: "fb_dale", name: "Dale Whitman", postsVisible: false },
      { platform: "facebook", id: "fb_riley", name: "Riley Park", postsVisible: false },
    ];

    this.posts = [
      post("instagram", "ig_p1", "First chair, deep day\n#snowboarding #powderday", 30, 1, { likes: 842, comments: 37, saves: 61 }),
      post("facebook", "fb_p1", "First chair, deep day", 30, 1, { likes: 129, comments: 12, shares: 9 }),
      post("instagram", "ig_p2", "Bluebird Tuesday", 54, 2, { likes: 611, comments: 18, saves: 40 }),
      post("facebook", "fb_p2", "Bluebird Tuesday", 54, 2, { likes: 77, comments: 4, shares: 2 }),
      post("youtube", "yt_p3", "Tree run line breakdown", 100, 3, { likes: 402, comments: 51, views: 9800 }),
      post("instagram", "ig_p4", "Rime ghosts at the summit", 170, 4, { likes: 1290, comments: 44, saves: 102 }),
    ];
    this.reactors.fb_p1 = [
      { platform: "facebook", id: "fb_dale", name: "Dale Whitman" },
      { platform: "facebook", id: "fb_riley", name: "Riley Park" },
      { platform: "facebook", id: "fb_k", name: "Kim Alvarez" },
    ];

    const person = (id: string): PersonRef => {
      const p = this.people.find((x) => x.id === id)!;
      return { platform: p.platform, id: p.id, username: p.username, name: p.name };
    };
    this.inbox = [
      comment("instagram", "c1", person("ig_maya.lens"), "That spray is unreal. What lens were you on for this?", 2, this.posts[0]),
      {
        id: inboxId("instagram", "dm", "t1"), platform: "instagram", kind: "dm", remoteId: "t1", person: person("ig_jordanruiz.films"),
        text: "We're putting together a winter team edit. Would you be up for filming a part in January?", at: ago(0.7),
        thread: [
          { id: "m0", text: "Saw your story from this morning, that line was sick", at: ago(20), fromMe: false },
          { id: "m1", text: "Thanks! Conditions were perfect", at: ago(19), fromMe: true },
          { id: "m2", text: "We're putting together a winter team edit. Would you be up for filming a part in January?", at: ago(0.7), fromMe: false },
        ],
        status: "open", replyWindowEndsAt: addHours(ago(0.7), 24), storyReply: true,
      },
      comment("youtube", "c2", person("UC_ana"), "At 4:12 you cut left instead of hitting the pillow. Was that the plan?", 5, this.posts[4]),
      comment("facebook", "c3", person("fb_dale"), "Which zone was this? Looks like the north bowl.", 26, this.posts[1]),
      {
        id: inboxId("instagram", "dm", "t2"), platform: "instagram", kind: "dm", remoteId: "t2", person: person("ig_sam.oduya"),
        text: "Are you riding Saturday?", at: ago(18), thread: [{ id: "s1", text: "Are you riding Saturday?", at: ago(18), fromMe: false }],
        status: "open", replyWindowEndsAt: addHours(ago(18), 24),
      },
      {
        id: inboxId("facebook", "dm", "t3"), platform: "facebook", kind: "dm", remoteId: "t3", person: person("fb_riley"),
        text: "Do you sell prints of the summit shot?", at: ago(22), thread: [{ id: "r1", text: "Do you sell prints of the summit shot?", at: ago(22), fromMe: false }],
        status: "open", replyWindowEndsAt: addHours(ago(22), 24),
      },
    ];
  }

  find(person: PersonRef): MockPerson | undefined {
    return this.people.find((p) => p.platform === person.platform && (p.id === person.id || (!!person.username && p.username === person.username)));
  }
}

function post(platform: PlatformId, id: string, caption: string, hoursAgo: number, seed: number, stats: PostStats): RemotePost {
  return {
    platform, remoteId: id, caption, at: ago(hoursAgo), stats,
    thumbUrl: snowArt(seed * 13, 600, 600), permalink: `https://example.com/${id}`,
    kind: platform === "youtube" ? "video" : "image",
  };
}

function comment(platform: PlatformId, id: string, person: PersonRef, text: string, hoursAgo: number, on: RemotePost): InboxItem {
  return {
    id: inboxId(platform, "comment", id), platform, kind: "comment", remoteId: id, person, text, at: ago(hoursAgo),
    context: { postId: on.remoteId, postTitle: on.caption.split("\n")[0], thumbUrl: on.thumbUrl },
    thread: [], status: "open",
    privateReplyUntil: platform === "youtube" ? undefined : addHours(ago(hoursAgo), 7 * 24),
  };
}

let world: World | undefined;
const getWorld = () => (world ??= new World());

const CAPS: Record<PlatformId, Capabilities> = {
  instagram: { nativeScheduling: false, dms: true, sendPost: true, follow: false, reactors: false },
  facebook: { nativeScheduling: true, dms: true, sendPost: true, follow: false, reactors: true },
  youtube: { nativeScheduling: true, dms: false, sendPost: false, follow: true, reactors: false },
};

export class MockAdapter implements PlatformAdapter {
  readonly capabilities: Capabilities;

  constructor(readonly id: PlatformId) {
    this.capabilities = CAPS[id];
  }

  private get w() {
    return getWorld();
  }

  async publish(draft: Draft, opts: PublishOptions): Promise<PublishResult> {
    for (let i = 1; i <= 8; i++) {
      await sleep(250 + Math.random() * 200);
      opts.onProgress({ state: i > 6 ? "processing" : "uploading", progress: i / 8 });
    }
    const remoteId = newId(`${this.id}_`);
    const caption = this.id === "youtube" ? draft.targets.youtube.title : captionFor(draft, this.id);
    this.w.posts.unshift({
      platform: this.id, remoteId, caption, at: (opts.scheduleAt ?? new Date()).toISOString(), stats: {},
      thumbUrl: draft.media[0]?.kind === "image" ? undefined : skateArt(remoteId.length),
      permalink: `https://example.com/${remoteId}`, kind: draft.media[0]?.kind === "video" ? "video" : "image",
    });
    return result(opts.scheduleAt ? "scheduled" : "published", { remoteId, permalink: `https://example.com/${remoteId}`, progress: 1 });
  }

  async fetchInbox(): Promise<InboxItem[]> {
    await sleep(400);
    return structuredClone(this.w.inbox.filter((i) => i.platform === this.id));
  }

  async reply(item: InboxItem, text: string): Promise<void> {
    await sleep(250);
    const live = this.w.inbox.find((i) => i.id === item.id);
    live?.thread.push({ id: newId(), text, at: new Date().toISOString(), fromMe: true });
  }

  async privateReply(item: InboxItem): Promise<void> {
    if (this.id === "youtube") throw new PlatformError("YouTube has no private replies.", "youtube");
    await sleep(250);
    const live = this.w.inbox.find((i) => i.id === item.id);
    if (live) live.privateReplySent = true;
  }

  async hide(item: InboxItem): Promise<void> {
    await sleep(200);
    this.w.inbox = this.w.inbox.filter((i) => i.id !== item.id);
  }

  async listMyPosts(limit: number): Promise<RemotePost[]> {
    await sleep(300);
    return structuredClone(this.w.posts.filter((p) => p.platform === this.id).slice(0, limit));
  }

  async postDetail(post: RemotePost) {
    await sleep(300);
    const commenters = this.w.inbox
      .filter((i) => i.kind === "comment" && i.context?.postId === post.remoteId)
      .map((i) => ({ person: i.person, text: i.text, at: i.at }));
    return {
      stats: post.stats,
      people: { commenters, reactors: this.id === "facebook" ? this.w.reactors[post.remoteId] ?? [] : undefined },
    };
  }

  async profile(person: PersonRef): Promise<PersonProfile> {
    await sleep(300);
    const p = this.w.find(person);
    if (!p) return { ...person, postsVisible: false };
    const { posts: _posts, ...profile } = p;
    return { ...profile };
  }

  async theirPosts(person: PersonProfile, cursor?: string): Promise<Page<TheirPost>> {
    await sleep(350);
    const all = this.w.find(person)?.posts ?? [];
    const start = cursor ? Number(cursor) : 0;
    const next = start + 8;
    return { items: all.slice(start, next), cursor: next < all.length ? String(next) : undefined };
  }

  async sendMessage(to: PersonRef, text: string): Promise<void> {
    await sleep(250);
    const conv = this.w.inbox.find((i) => i.kind === "dm" && i.person.id === to.id);
    if (!conv) throw new PlatformError("No open conversation with this person.", this.id);
    conv.thread.push({ id: newId(), text, at: new Date().toISOString(), fromMe: true });
  }

  async sendPost(to: PersonRef, post: RemotePost, note: string): Promise<void> {
    await this.sendMessage(to, [note.trim(), `[${post.caption.split("\n")[0]}]`].filter(Boolean).join("\n"));
  }

  async follow(person: PersonRef): Promise<void> {
    await sleep(300);
    const p = this.w.find(person);
    if (p) p.youFollow = true;
  }
}

/** Remove the adapters' capability to do things the real platform can't. */
export function mockAdapters(): Record<PlatformId, PlatformAdapter> {
  const make = (id: PlatformId) => {
    const a = new MockAdapter(id);
    if (!a.capabilities.dms) {
      // Match the real YouTube adapter, which has no DM methods at all.
      Object.assign(a, { sendMessage: undefined, sendPost: undefined, privateReply: undefined });
    }
    if (!a.capabilities.follow) Object.assign(a, { follow: undefined });
    return a;
  };
  return { instagram: make("instagram"), facebook: make("facebook"), youtube: make("youtube") };
}
