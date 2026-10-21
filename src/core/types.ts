// The shared vocabulary of the app. Everything else speaks in these types.

export type PlatformId = "instagram" | "facebook" | "youtube";
export const PLATFORMS: readonly PlatformId[] = ["instagram", "facebook", "youtube"];

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
};

// ---------- Media ----------

export type MediaKind = "image" | "video";

export interface MediaFile {
  id: string;
  /** Absolute path on disk (a sample id in preview mode). */
  path: string;
  name: string;
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  /** Last-modified time of the file, ms since epoch. */
  modifiedAt?: number;
}

// ---------- Drafts & publishing ----------

export type InstagramFormat = "post" | "reel" | "story" | "carousel";
export type FacebookFormat = "post" | "reel" | "video";
export type YouTubePrivacy = "public" | "unlisted" | "private";

export interface InstagramTarget {
  enabled: boolean;
  format: InstagramFormat;
  captionOverride?: string;
  /** Reels only: also show the Reel in the profile grid. */
  shareToFeed: boolean;
}

export interface FacebookTarget {
  enabled: boolean;
  format: FacebookFormat;
  captionOverride?: string;
}

export interface YouTubeTarget {
  enabled: boolean;
  title: string;
  descriptionOverride?: string;
  privacy: YouTubePrivacy;
  madeForKids: boolean;
  tags: string[];
}

export interface DraftTargets {
  instagram: InstagramTarget;
  facebook: FacebookTarget;
  youtube: YouTubeTarget;
}

export type PublishState =
  | "waiting" // queued, nothing sent yet
  | "uploading"
  | "processing" // the platform is digesting the file
  | "scheduled" // handed to the platform with a future publish time
  | "published"
  | "failed";

export interface PublishResult {
  state: PublishState;
  /** 0..1 while uploading/processing. */
  progress?: number;
  remoteId?: string;
  permalink?: string;
  error?: string;
  /** Extra human note, e.g. "Uploaded as private until your project is audited." */
  note?: string;
  updatedAt: string;
}

export type DraftStatus = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed";

export interface Draft {
  id: string;
  createdAt: string;
  updatedAt: string;
  media: MediaFile[];
  caption: string;
  targets: DraftTargets;
  /** ISO time; null = publish when you press the button. */
  scheduledFor: string | null;
  status: DraftStatus;
  results: Partial<Record<PlatformId, PublishResult>>;
  publishedAt?: string;
}

// ---------- People ----------

/** Enough to identify someone on one platform. */
export interface PersonRef {
  platform: PlatformId;
  /** IG-scoped id, Page-scoped id, or YouTube channel id. */
  id?: string;
  /** Instagram username (no @). */
  username?: string;
  name: string;
}

export interface PersonProfile extends PersonRef {
  avatarUrl?: string;
  bio?: string;
  followers?: number;
  postsCount?: number;
  followsYou?: boolean;
  youFollow?: boolean;
  /** Can we list their posts? (Instagram: creator/business accounts only.) */
  postsVisible: boolean;
  /** Their profile on the platform's website, if one can be linked. */
  profileUrl?: string;
}

export interface TheirPost {
  id: string;
  thumbUrl?: string;
  caption?: string;
  kind: "image" | "video" | "carousel";
  likes?: number;
  comments?: number;
  views?: number;
  permalink?: string;
  at?: string;
}

export interface Page<T> {
  items: T[];
  /** Pass back to get the next page; undefined = no more. */
  cursor?: string;
}

// ---------- Inbox ----------

export type InboxKind = "comment" | "dm";
export type InboxStatus = "open" | "done" | "hidden";

export interface InboxMessage {
  id: string;
  text: string;
  at: string;
  fromMe: boolean;
}

export interface InboxItem {
  /** Stable local id: `${platform}:${kind}:${remoteId}` */
  id: string;
  platform: PlatformId;
  kind: InboxKind;
  /** Comment id, or conversation id for DMs. */
  remoteId: string;
  person: PersonRef;
  /** The latest thing they said. */
  text: string;
  /** When they said it. */
  at: string;
  /** For comments: the post it's on. */
  context?: { postId: string; postTitle?: string; thumbUrl?: string };
  /** DMs: recent messages, oldest first. Comments: replies underneath. */
  thread: InboxMessage[];
  status: InboxStatus;
  /** DMs: when Meta's 24-hour reply window closes. */
  replyWindowEndsAt?: string;
  /** DM that replied to one of your stories. */
  storyReply?: boolean;
  /** Meta comments: you may send this person one private DM about it. */
  privateReplyUntil?: string;
  privateReplySent?: boolean;
  /** When you marked it done/hidden, so new activity can reopen it. */
  resolvedAt?: string;
}

// ---------- Your published work ----------

export interface PostStats {
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  views?: number;
}

/** One of your posts on one platform. */
export interface RemotePost {
  platform: PlatformId;
  remoteId: string;
  caption: string;
  thumbUrl?: string;
  permalink?: string;
  at: string;
  kind: "image" | "video" | "carousel" | "story";
  stats: PostStats;
}

/** A post as Work shows it: the same piece across one or more platforms. */
export interface WorkItem {
  key: string;
  title: string;
  at: string;
  thumbUrl?: string;
  draftId?: string;
  posts: RemotePost[];
}

export interface PostPeople {
  commenters: { person: PersonRef; text: string; at: string }[];
  /** Facebook only: who reacted. Instagram and YouTube don't share this. */
  reactors?: PersonRef[];
}

// ---------- Accounts & settings ----------

export interface MetaAccount {
  pageId: string;
  pageName: string;
  instagramUserId?: string;
  instagramUsername?: string;
  connectedAt: string;
}

export interface YouTubeAccount {
  channelId: string;
  channelTitle: string;
  connectedAt: string;
}

export interface Accounts {
  meta?: MetaAccount;
  youtube?: YouTubeAccount;
}

export type Season = "winter" | "summer";

export interface Settings {
  outboxPath: string;
  /** Local times ("HH:MM") when the inbox gathers new comments and DMs. */
  inboxCheckTimes: string[];
  /** Minutes per inbox session. 0 = no limit. */
  inboxTimeboxMinutes: number;
  /** Hand Facebook and YouTube posts to the platform's own scheduler. */
  usePlatformScheduling: boolean;
  /** How far back to look for comments, in days. */
  commentLookbackDays: number;
  defaultTargets: Record<PlatformId, boolean>;
  season: Season;
  /** Saved hashtag sets, shown as quick-add chips in Studio. */
  tagSets: { name: string; tags: string }[];
  metaGraphVersion: string;
  /** Supabase bucket used for the brief Instagram photo hand-off. */
  stagingBucket: string;
}

export const DEFAULT_SETTINGS: Settings = {
  outboxPath: "",
  inboxCheckTimes: ["09:00", "13:00", "18:00"],
  inboxTimeboxMinutes: 20,
  usePlatformScheduling: true,
  commentLookbackDays: 30,
  defaultTargets: { instagram: true, facebook: true, youtube: true },
  season: "winter",
  tagSets: [
    { name: "Winter", tags: "#snowboarding #powderday #bluebird" },
    { name: "Backcountry", tags: "#backcountry #splitboarding" },
    { name: "Summer", tags: "#skateboarding #skatelife" },
  ],
  metaGraphVersion: "v24.0",
  stagingBucket: "conduit-staging",
};
