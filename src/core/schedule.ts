import type { Draft, PlatformId } from "./types";

/** "09:00" -> minutes after midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** The next inbox check after `now`, in local time. */
export function nextCheckTime(times: string[], now = new Date()): Date | null {
  if (!times.length) return null;
  const sorted = [...times].map(toMinutes).sort((a, b) => a - b);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = sorted.find((m) => m > nowMin);
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (today !== undefined) {
    d.setHours(Math.floor(today / 60), today % 60);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(Math.floor(sorted[0] / 60), sorted[0] % 60);
  }
  return d;
}

/** Most recent scheduled check at or before `now` (to catch up after sleep). */
export function lastCheckTime(times: string[], now = new Date()): Date | null {
  if (!times.length) return null;
  const sorted = [...times].map(toMinutes).sort((a, b) => b - a);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = sorted.find((m) => m <= nowMin);
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (today !== undefined) {
    d.setHours(Math.floor(today / 60), today % 60);
  } else {
    d.setDate(d.getDate() - 1);
    d.setHours(Math.floor(sorted[0] / 60), sorted[0] % 60);
  }
  return d;
}

/** Should the inbox check now? True if a check time has passed since the last sync. */
export function inboxCheckDue(times: string[], lastSyncedAt: string | undefined, now = new Date()): boolean {
  const last = lastCheckTime(times, now);
  if (!last) return false;
  if (!lastSyncedAt) return true;
  return new Date(lastSyncedAt).getTime() < last.getTime();
}

// Facebook needs a scheduled post to be 10 min to ~30 days out. YouTube is
// flexible, but we use the same window so behaviour is predictable.
const NATIVE_MIN_MS = 15 * 60_000;
const NATIVE_MAX_MS = 29 * 24 * 3600_000;

export function canUsePlatformScheduler(scheduleAt: Date, now = new Date()): boolean {
  const ahead = scheduleAt.getTime() - now.getTime();
  return ahead >= NATIVE_MIN_MS && ahead <= NATIVE_MAX_MS;
}

/** Platforms on a draft that the app itself still has to publish now. */
export function platformsDueNow(draft: Draft, now = new Date()): PlatformId[] {
  if (!draft.scheduledFor) return [];
  if (new Date(draft.scheduledFor).getTime() > now.getTime()) return [];
  return (["instagram", "facebook", "youtube"] as PlatformId[]).filter((p) => {
    if (!draft.targets[p].enabled) return false;
    const r = draft.results[p];
    return !r || r.state === "waiting";
  });
}

export function relativeTime(iso: string, now = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const phrase = mins < 1 ? "now" : mins < 60 ? `${mins} min` : hours < 24 ? `${hours} h` : `${days} d`;
  if (phrase === "now") return "just now";
  return diff < 0 ? `${phrase} ago` : `in ${phrase}`;
}

export function clockTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dayAndTime(d: Date | string, now = new Date()): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const day = sameDay ? "Today" : date.toDateString() === tomorrow.toDateString() ? "Tomorrow"
    : date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day}, ${clockTime(date)}`;
}
