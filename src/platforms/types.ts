import type {
  Draft, InboxItem, MediaFile, Page, PersonProfile, PersonRef, PlatformId, PostPeople, PostStats, PublishResult, RemotePost,
  TheirPost,
} from "../core/types";

export interface PublishOptions {
  /** If set, the platform holds the post until this time itself. */
  scheduleAt?: Date;
  onProgress: (update: Partial<PublishResult>) => void;
}

/** What a platform lets an app do. The UI reads this to show or explain buttons. */
export interface Capabilities {
  /** Platform can hold a post until a future time on its own. */
  nativeScheduling: boolean;
  dms: boolean;
  /** Can send someone your post in a DM. */
  sendPost: boolean;
  /** Can follow/subscribe from inside the app. */
  follow: boolean;
  /** Shares who reacted to your posts. */
  reactors: boolean;
}

/** Everything the app needs from one platform. */
export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly capabilities: Capabilities;

  publish(draft: Draft, opts: PublishOptions): Promise<PublishResult>;

  /** Comments and DMs addressed to you. */
  fetchInbox(opts: { lookbackDays: number }): Promise<InboxItem[]>;
  reply(item: InboxItem, text: string): Promise<void>;
  /** Meta only: one private DM to someone who commented. */
  privateReply?(item: InboxItem, text: string): Promise<void>;
  /** Hide a comment from public view. */
  hide(item: InboxItem): Promise<void>;

  /** Your recent posts with their numbers. */
  listMyPosts(limit: number): Promise<RemotePost[]>;
  /** Fresh numbers and the people around one of your posts. */
  postDetail(post: RemotePost): Promise<{ stats: PostStats; people: PostPeople }>;

  profile(person: PersonRef): Promise<PersonProfile>;
  theirPosts(person: PersonProfile, cursor?: string): Promise<Page<TheirPost>>;
  /** Send one of your posts to someone in an open conversation. */
  sendPost?(to: PersonRef, post: RemotePost, note: string): Promise<void>;
  /** DM someone in an open conversation. */
  sendMessage?(to: PersonRef, text: string): Promise<void>;
  follow?(person: PersonRef): Promise<void>;
}

/** How adapters read the files they upload. */
export interface MediaReader {
  bytes(m: MediaFile): Promise<Uint8Array>;
  chunk(m: MediaFile, offset: number, length: number): Promise<Uint8Array>;
  /** The file as JPEG, converting if needed (Instagram only accepts JPEG). */
  jpeg(m: MediaFile): Promise<Uint8Array>;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly platform: PlatformId,
    readonly detail?: unknown,
    /** True if logging in again would probably fix it. */
    readonly needsReconnect = false,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function inboxId(platform: PlatformId, kind: "comment" | "dm", remoteId: string): string {
  return `${platform}:${kind}:${remoteId}`;
}

/** Turn anything thrown into a sentence a person can read. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Something went wrong.";
}
