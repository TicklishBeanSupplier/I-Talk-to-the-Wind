import type { InboxItem, InboxMessage, MetaAccount, PersonRef } from "../../core/types";
import { addHours, daysAgo } from "../../core/util";
import { inboxId, PlatformError } from "../types";
import type { GraphClient } from "./graph";

type Surface = "instagram" | "facebook";

interface RawMessage {
  id: string;
  created_time: string;
  message?: string;
  from?: { id: string; username?: string; name?: string };
  story?: { reply_to?: unknown; mention?: unknown };
  attachments?: unknown;
}

interface RawConversation {
  id: string;
  updated_time: string;
  participants?: { data: { id: string; username?: string; name?: string }[] };
  messages?: { data: RawMessage[] };
}

const BASE_MESSAGE_FIELDS = "id,created_time,message,from";

/**
 * Conversations with people who wrote to you, newest first.
 * Instagram may refuse the `story` field on some API versions, so we retry without it.
 */
export async function fetchConversations(
  graph: GraphClient,
  account: MetaAccount,
  surface: Surface,
  lookbackDays: number,
): Promise<InboxItem[]> {
  const params = (messageFields: string) => ({
    platform: surface === "instagram" ? "instagram" : "messenger",
    fields: `id,updated_time,participants,messages.limit(10){${messageFields}}`,
    limit: 25,
  });

  let convs: RawConversation[];
  try {
    convs = await graph.getAll<RawConversation>(
      `${account.pageId}/conversations`,
      params(surface === "instagram" ? `${BASE_MESSAGE_FIELDS},story` : BASE_MESSAGE_FIELDS),
      2,
    );
  } catch (err) {
    if (surface !== "instagram" || !isUnknownField(err)) throw err;
    convs = await graph.getAll<RawConversation>(`${account.pageId}/conversations`, params(BASE_MESSAGE_FIELDS), 2);
  }

  const myIds = new Set([account.pageId, account.instagramUserId].filter(Boolean) as string[]);
  const cutoff = daysAgo(lookbackDays).getTime();
  const items: InboxItem[] = [];

  for (const c of convs) {
    if (new Date(c.updated_time).getTime() < cutoff) continue;
    const other = c.participants?.data.find((p) => !myIds.has(p.id));
    if (!other) continue;

    const raw = [...(c.messages?.data ?? [])].reverse(); // API gives newest first
    const thread: InboxMessage[] = raw.map((m) => ({
      id: m.id,
      text: m.message?.trim() || (m.story ? "Replied to your story" : "Sent an attachment"),
      at: m.created_time,
      fromMe: !!m.from && myIds.has(m.from.id),
    }));
    const lastTheirs = [...raw].reverse().find((m) => !(m.from && myIds.has(m.from.id)));
    if (!lastTheirs) continue; // only messages from you: nothing to answer

    const person: PersonRef = {
      platform: surface,
      id: other.id,
      username: other.username,
      name: other.name ?? other.username ?? "Someone",
    };
    items.push({
      id: inboxId(surface, "dm", c.id),
      platform: surface,
      kind: "dm",
      remoteId: c.id,
      person,
      text: thread.find((t) => t.id === lastTheirs.id)!.text,
      at: lastTheirs.created_time,
      thread,
      status: "open",
      replyWindowEndsAt: addHours(lastTheirs.created_time, 24),
      storyReply: !!lastTheirs.story?.reply_to,
    });
  }
  return items;
}

export async function sendText(graph: GraphClient, account: MetaAccount, to: PersonRef, text: string): Promise<void> {
  if (!to.id) throw new PlatformError("Can't message this person: no conversation with them yet.", to.platform);
  await graph.postJson(`${account.pageId}/messages`, {
    recipient: { id: to.id },
    messaging_type: "RESPONSE",
    message: { text },
  });
}

/** One private DM to someone who commented on your post (Meta allows one, within 7 days). */
export async function sendPrivateReply(graph: GraphClient, account: MetaAccount, commentId: string, text: string): Promise<void> {
  await graph.postJson(`${account.pageId}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

export const PRIVATE_REPLY_DAYS = 7;

function isUnknownField(err: unknown): boolean {
  const detail = (err as { detail?: { error?: { code?: number } } })?.detail;
  return detail?.error?.code === 100;
}
