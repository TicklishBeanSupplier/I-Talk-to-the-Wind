import type { InboxItem, PersonRef } from "./types";

const time = (iso: string | undefined) => (iso ? new Date(iso).getTime() : 0);

/**
 * Combine freshly fetched items with what we already have.
 * - Keeps your done/hidden decisions.
 * - Reopens an item if they wrote again after you closed it.
 * - Closes items you already answered elsewhere (e.g. on your phone).
 * Items not in `fetched` are kept as-is (they may just be outside the lookback).
 */
export function mergeInbox(existing: InboxItem[], fetched: InboxItem[], now = new Date()): InboxItem[] {
  const out = new Map(existing.map((i) => [i.id, i]));

  for (const f of fetched) {
    const prev = out.get(f.id);
    const answered = lastMessageIsMine(f);

    if (!prev) {
      out.set(f.id, { ...f, status: answered ? "done" : "open", resolvedAt: answered ? now.toISOString() : undefined });
      continue;
    }

    let { status, resolvedAt } = prev;
    if (status === "done" && !answered && time(f.at) > time(resolvedAt ?? prev.at)) {
      status = "open";
      resolvedAt = undefined;
    } else if (status === "open" && answered) {
      status = "done";
      resolvedAt = now.toISOString();
    }
    out.set(f.id, {
      ...f,
      status,
      resolvedAt,
      privateReplySent: prev.privateReplySent || f.privateReplySent,
    });
  }

  return [...out.values()].sort((a, b) => time(b.at) - time(a.at));
}

function lastMessageIsMine(item: InboxItem): boolean {
  const last = item.thread[item.thread.length - 1];
  return !!last && last.fromMe && time(last.at) >= time(item.at);
}

/** DMs can only be answered inside Meta's 24-hour window. */
export function canReply(item: InboxItem, now = new Date()): boolean {
  if (item.kind !== "dm" || !item.replyWindowEndsAt) return true;
  return time(item.replyWindowEndsAt) > now.getTime();
}

export function canPrivateReply(item: InboxItem, now = new Date()): boolean {
  return item.kind === "comment" && !item.privateReplySent && !!item.privateReplyUntil && time(item.privateReplyUntil) > now.getTime();
}

/** Drop resolved items older than `days` so storage doesn't grow forever. */
export function pruneInbox(items: InboxItem[], days: number, now = new Date()): InboxItem[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return items.filter((i) => i.status === "open" || time(i.at) >= cutoff);
}

// ---------- People ----------

/** One key per person per platform, whichever identifier we have. */
export function personKey(p: PersonRef): string {
  const handle = p.username ? `@${p.username.toLowerCase()}` : p.id ?? `~${p.name.toLowerCase()}`;
  return `${p.platform}:${handle}`;
}

/**
 * Do two references point at the same person? Usernames win because Meta
 * gives the same person different ids in comments and in DMs.
 */
export function samePerson(a: PersonRef, b: PersonRef): boolean {
  if (a.platform !== b.platform) return false;
  if (a.username && b.username) return a.username.toLowerCase() === b.username.toLowerCase();
  if (a.id && b.id) return a.id === b.id;
  return a.name.toLowerCase() === b.name.toLowerCase();
}

export interface History {
  messages: number;
  comments: number;
  storyReplies: number;
  firstAt?: string;
  lastCommentOn?: string;
}

/** What someone has done with you, from the inbox you've kept. */
export function historyWith(items: InboxItem[], person: PersonRef): History {
  const h: History = { messages: 0, comments: 0, storyReplies: 0 };
  let lastCommentAt = 0;
  for (const i of items) {
    if (!samePerson(i.person, person)) continue;
    if (i.kind === "comment") {
      h.comments++;
      if (time(i.at) > lastCommentAt) {
        lastCommentAt = time(i.at);
        h.lastCommentOn = i.context?.postTitle;
      }
    } else {
      const theirs = i.thread.filter((m) => !m.fromMe).length || 1;
      h.messages += theirs;
      if (i.storyReply) h.storyReplies++;
    }
    const first = i.kind === "dm" ? i.thread[0]?.at ?? i.at : i.at;
    if (!h.firstAt || time(first) < time(h.firstAt)) h.firstAt = first;
  }
  return h;
}

/** The open conversation with someone, if Meta still lets you write to them. */
export function openConversationWith(items: InboxItem[], person: PersonRef, now = new Date()): InboxItem | undefined {
  return items.find((i) => i.kind === "dm" && samePerson(i.person, person) && canReply(i, now));
}
