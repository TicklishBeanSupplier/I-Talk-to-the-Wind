// The app's single source of truth: what's on screen, what's saved, and
// every action a screen can take. Screens read slices of this with selectors.
import { create } from "zustand";
import { newDraft, overallStatus, result } from "../core/drafts";
import { canPrivateReply, canReply, mergeInbox, pruneInbox } from "../core/inbox";
import { adoptExisting, emptyOutbox, scanOutbox, type OutboxMemory } from "../core/outbox";
import { planPublish, runPublish } from "../core/publish";
import { inboxCheckDue, platformsDueNow } from "../core/schedule";
import type {
  Accounts, Draft, InboxItem, MediaFile, PersonRef, PlatformId, PublishResult, RemotePost, Settings,
} from "../core/types";
import { DEFAULT_SETTINGS, PLATFORM_LABEL, PLATFORMS } from "../core/types";
import { mediaTypeFromName, newId, nowIso } from "../core/util";
import { blocking, validateDraft } from "../core/validate";
import { errorMessage } from "../platforms/types";
import type { DirEntry, Runtime } from "../runtime/types";
import { buildAdapters, type Adapters } from "./services";

// ---------- Types ----------

export type Route =
  | { screen: "studio"; draftId?: string }
  | { screen: "inbox"; itemId?: string }
  | { screen: "work"; key?: string }
  | { screen: "person"; person: PersonRef }
  | { screen: "settings" };

export interface Toast {
  id: string;
  text: string;
  tone: "info" | "success" | "error";
}

interface Persisted {
  settings: Settings;
  accounts: Accounts;
  drafts: Draft[];
  inbox: InboxItem[];
  lastSyncAt?: string;
  outbox: OutboxMemory;
}

const PERSISTED_KEYS = ["settings", "accounts", "drafts", "inbox", "lastSyncAt", "outbox"] as const satisfies readonly (keyof Persisted)[];

export interface AppState extends Persisted {
  rt: Runtime | null;
  ready: boolean;
  adapters: Adapters;
  route: Route;
  history: Route[];
  toasts: Toast[];
  syncing: boolean;
  syncErrors: Partial<Record<PlatformId, string>>;
  work: { posts: RemotePost[]; fetchedAt?: number; loading: boolean; errors: Partial<Record<PlatformId, string>> };
}

const KEEP_RESOLVED_DAYS = 60;
const WORK_FRESH_MS = 10 * 60_000;

const initial: Omit<AppState, "rt"> = {
  ready: false,
  settings: DEFAULT_SETTINGS,
  accounts: {},
  drafts: [],
  inbox: [],
  outbox: emptyOutbox(),
  adapters: {},
  route: { screen: "studio" },
  history: [],
  toasts: [],
  syncing: false,
  syncErrors: {},
  work: { posts: [], loading: false, errors: {} },
};

export const useApp = create<AppState>()(() => ({ ...initial, rt: null }));

const get = useApp.getState;
const set = useApp.setState;

function runtime(): Runtime {
  const rt = get().rt;
  if (!rt) throw new Error("The app isn't ready yet.");
  return rt;
}

// ---------- Start-up & saving ----------

export async function init(rt: Runtime): Promise<void> {
  const loaded = await Promise.all(PERSISTED_KEYS.map((k) => rt.data.get<unknown>(k)));
  const saved = Object.fromEntries(PERSISTED_KEYS.map((k, i) => [k, loaded[i]])) as Partial<Persisted>;

  const settings: Settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  const accounts = saved.accounts ?? {};
  // Uploads can't survive a restart: mark them so they can be retried.
  const drafts = (saved.drafts ?? []).map(recoverInterrupted);

  set({
    rt,
    settings,
    accounts,
    drafts,
    inbox: saved.inbox ?? [],
    lastSyncAt: saved.lastSyncAt,
    outbox: saved.outbox ?? emptyOutbox(),
    adapters: buildAdapters(rt, accounts, settings),
    route: accounts.meta || accounts.youtube || rt.kind === "preview" ? { screen: "studio" } : { screen: "settings" },
    ready: true,
  });

  startAutosave(rt);
}

function recoverInterrupted(d: Draft): Draft {
  let changed = false;
  const results = { ...d.results };
  for (const p of PLATFORMS) {
    const r = results[p];
    if (r && (r.state === "uploading" || r.state === "processing")) {
      results[p] = result("failed", { error: "Interrupted when Conduit closed. Try again." });
      changed = true;
    }
  }
  if (!changed) return d;
  const next = { ...d, results };
  return { ...next, status: overallStatus(next) };
}

/** Save each persisted slice shortly after it changes. */
function startAutosave(rt: Runtime) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  useApp.subscribe((state, prev) => {
    for (const key of PERSISTED_KEYS) {
      if (state[key] === prev[key]) continue;
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          rt.data.set(key, get()[key]).catch((err) => toast(`Couldn't save ${key}: ${errorMessage(err)}`, "error"));
        }, 400),
      );
    }
  });
}

// ---------- Navigation & toasts ----------

export function navigate(route: Route) {
  const { route: current, history } = get();
  set({ route, history: [...history.slice(-20), current] });
}

export function back() {
  const { history } = get();
  const prev = history[history.length - 1];
  if (prev) set({ route: prev, history: history.slice(0, -1) });
}

export function toast(text: string, tone: Toast["tone"] = "info") {
  const id = newId("t_");
  set({ toasts: [...get().toasts, { id, text, tone }].slice(-4) });
  setTimeout(() => dismissToast(id), tone === "error" ? 8000 : 4000);
}

export function dismissToast(id: string) {
  set({ toasts: get().toasts.filter((t) => t.id !== id) });
}

// ---------- Settings & accounts ----------

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings, ...patch };
  const rebuild = patch.metaGraphVersion !== undefined || patch.stagingBucket !== undefined;
  set({ settings, ...(rebuild ? { adapters: buildAdapters(runtime(), get().accounts, settings) } : {}) });
}

export function setAccounts(accounts: Accounts) {
  set({ accounts, adapters: buildAdapters(runtime(), accounts, get().settings), work: { ...initial.work } });
}

export async function chooseOutbox(): Promise<void> {
  const rt = runtime();
  const path = await rt.files.pickFolder();
  if (!path) return;
  const entries = await rt.files.listDir(path);
  // What's already there is old news; only new exports become drafts.
  set({ outbox: adoptExisting(entries) });
  updateSettings({ outboxPath: path });
  const media = entries.filter((e) => mediaTypeFromName(e.name)).length;
  toast(media ? `Watching the folder. ${media} existing file${media === 1 ? " was" : "s were"} left alone; add them with "Add files".` : "Watching the folder for new exports.", "success");
}

// ---------- Drafts ----------

async function toMedia(entry: DirEntry): Promise<MediaFile | null> {
  const type = mediaTypeFromName(entry.name);
  if (!type) return null;
  const info = await runtime().files.probe(entry.path, type.kind);
  return { id: newId("m_"), path: entry.path, name: entry.name, kind: type.kind, mime: type.mime, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt, ...info };
}

async function mediaFromPaths(paths: string[]): Promise<MediaFile[]> {
  const rt = runtime();
  const entries = await Promise.all(paths.map((p) => rt.files.fileInfo(p)));
  const media = await Promise.all(entries.map(toMedia));
  return media.filter((m): m is MediaFile => !!m);
}

function addDraft(media: MediaFile[]): Draft {
  const { settings, adapters } = get();
  // Only switch on platforms that are actually connected.
  const defaults = Object.fromEntries(PLATFORMS.map((p) => [p, settings.defaultTargets[p] && !!adapters[p]])) as Settings["defaultTargets"];
  const d = newDraft(media, { defaultTargets: defaults });
  set({ drafts: [d, ...get().drafts] });
  return d;
}

/** Studio's "Add files" button: pick files, make one draft from them. */
export async function draftFromPicker(): Promise<void> {
  const paths = await runtime().files.pickFiles();
  if (!paths.length) return;
  const media = await mediaFromPaths(paths);
  if (!media.length) return toast("Those files aren't photos or videos Conduit can post.", "error");
  const d = addDraft(media);
  navigate({ screen: "studio", draftId: d.id });
}

export async function addMediaToDraft(draftId: string): Promise<void> {
  const paths = await runtime().files.pickFiles();
  if (!paths.length) return;
  const media = await mediaFromPaths(paths);
  updateDraft(draftId, (d) => {
    const all = [...d.media, ...media];
    // More than one file: Instagram carousel or Facebook photo set; YouTube takes one video only.
    const multi = all.length > 1;
    return {
      media: all,
      targets: {
        ...d.targets,
        instagram: multi ? { ...d.targets.instagram, format: "carousel" as const } : d.targets.instagram,
        facebook: multi ? { ...d.targets.facebook, format: "post" as const } : d.targets.facebook,
        youtube: multi ? { ...d.targets.youtube, enabled: false } : d.targets.youtube,
      },
    };
  });
}

export function updateDraft(id: string, change: Partial<Draft> | ((d: Draft) => Partial<Draft>)) {
  set({
    drafts: get().drafts.map((d) => {
      if (d.id !== id) return d;
      const next = { ...d, ...(typeof change === "function" ? change(d) : change), updatedAt: nowIso() };
      return { ...next, status: overallStatus(next) };
    }),
  });
}

export function deleteDraft(id: string) {
  const d = get().drafts.find((x) => x.id === id);
  if (d && (d.status === "publishing")) return toast("Wait for the upload to finish first.", "error");
  set({ drafts: get().drafts.filter((x) => x.id !== id) });
  const r = get().route;
  if (r.screen === "studio" && r.draftId === id) set({ route: { screen: "studio" } });
}

function setResult(draftId: string, platform: PlatformId, update: Partial<PublishResult>) {
  updateDraft(draftId, (d) => {
    const prev = d.results[platform] ?? result("waiting");
    const results = { ...d.results, [platform]: { ...prev, ...update, updatedAt: nowIso() } };
    return { results, publishedAt: d.publishedAt ?? (update.state === "published" ? nowIso() : undefined) };
  });
}

/**
 * Publish now, or schedule. Platforms that can hold a post get it right away
 * with the future time; the rest wait for the app to send them on time.
 */
export async function publishDraft(id: string): Promise<void> {
  const { drafts, adapters, settings } = get();
  const draft = drafts.find((d) => d.id === id);
  if (!draft) return;
  if (blocking(validateDraft(draft))) return toast("Fix the items marked in red first.", "error");

  const plan = planPublish(draft, adapters, settings.usePlatformScheduling);
  for (const p of plan.later) setResult(id, p, result("waiting"));
  const at = draft.scheduledFor ? new Date(draft.scheduledFor) : undefined;

  const jobs: Promise<void>[] = [];
  if (plan.now.length) jobs.push(runPublish(draft, plan.now, adapters, (p, u) => setResult(id, p, u)));
  if (plan.handOff.length) jobs.push(runPublish(draft, plan.handOff, adapters, (p, u) => setResult(id, p, u), at));
  if (!jobs.length && plan.later.length) toast("Scheduled. Keep Conduit running (it can sit in the tray).", "success");
  await Promise.all(jobs);
  announce(id);
}

/**
 * Take a scheduled draft back to editing. Posts already handed to Facebook
 * or YouTube stay scheduled there (cancel those on the platform).
 */
export function unschedule(id: string) {
  updateDraft(id, (d) => {
    const results = { ...d.results };
    for (const p of PLATFORMS) if (results[p]?.state === "waiting") delete results[p];
    return { results };
  });
}

/** Retry one platform that failed. */
export async function retryPlatform(id: string, platform: PlatformId): Promise<void> {
  const { drafts, adapters } = get();
  const draft = drafts.find((d) => d.id === id);
  if (!draft) return;
  const at = draft.scheduledFor && new Date(draft.scheduledFor) > new Date() ? new Date(draft.scheduledFor) : undefined;
  if (at && !adapters[platform]?.capabilities.nativeScheduling) return setResult(id, platform, result("waiting"));
  await runPublish(draft, [platform], adapters, (p, u) => setResult(id, p, u), at);
  announce(id);
}

function announce(id: string) {
  const d = get().drafts.find((x) => x.id === id);
  if (!d) return;
  const failed = PLATFORMS.filter((p) => d.results[p]?.state === "failed");
  if (failed.length) toast(`Didn't go out on ${failed.map((p) => PLATFORM_LABEL[p]).join(" and ")}. See the details in Studio.`, "error");
  else if (d.status === "published") toast("Posted.", "success");
  else if (d.status === "scheduled") toast("Scheduled.", "success");
}

// ---------- Background work ----------

let ticking = false;

/** Runs every 30 s and on wake: due posts, inbox checks. */
export async function tick(): Promise<void> {
  if (ticking || !get().ready) return;
  ticking = true;
  try {
    const { drafts, adapters, settings, lastSyncAt } = get();
    const now = new Date();
    await Promise.all(
      drafts.map(async (d) => {
        const due = platformsDueNow(d, now);
        if (!due.length) return;
        await runPublish(d, due, adapters, (p, u) => setResult(d.id, p, u));
        announce(d.id);
      }),
    );
    if (Object.keys(adapters).length && inboxCheckDue(settings.inboxCheckTimes, lastSyncAt, now)) await syncInbox();
  } finally {
    ticking = false;
  }
}

let scanning = false;

/** Look for new exports in the Outbox folder. Cheap; runs every few seconds. */
export async function scanOutboxNow(): Promise<void> {
  const { outboxPath } = get().settings;
  if (scanning || !outboxPath || !get().ready) return;
  scanning = true;
  try {
    const entries = await runtime().files.listDir(outboxPath);
    const { ready, memory } = scanOutbox(entries, get().outbox);
    set({ outbox: memory });
    for (const entry of ready) {
      const m = await toMedia(entry);
      if (m) addDraft([m]);
    }
    if (ready.length) toast(ready.length === 1 ? `New export: ${ready[0].name}` : `${ready.length} new exports`, "info");
  } catch (err) {
    // A missing folder (unplugged drive) shouldn't spam: report once per session.
    if (!scanErrorShown) toast(`Can't read the Outbox folder: ${errorMessage(err)}`, "error");
    scanErrorShown = true;
  } finally {
    scanning = false;
  }
}
let scanErrorShown = false;

// ---------- Inbox ----------

export async function syncInbox(): Promise<void> {
  const { adapters, settings, syncing } = get();
  if (syncing) return;
  set({ syncing: true });
  const errors: Partial<Record<PlatformId, string>> = {};
  const batches = await Promise.all(
    (Object.values(adapters) as NonNullable<Adapters[PlatformId]>[]).map(async (a) => {
      try {
        return await a.fetchInbox({ lookbackDays: settings.commentLookbackDays });
      } catch (err) {
        errors[a.id] = errorMessage(err);
        return [];
      }
    }),
  );
  const merged = pruneInbox(mergeInbox(get().inbox, batches.flat()), KEEP_RESOLVED_DAYS);
  set({ inbox: merged, lastSyncAt: nowIso(), syncing: false, syncErrors: errors });
}

function patchItem(id: string, patch: Partial<InboxItem> | ((i: InboxItem) => Partial<InboxItem>)) {
  set({ inbox: get().inbox.map((i) => (i.id === id ? { ...i, ...(typeof patch === "function" ? patch(i) : patch) } : i)) });
}

function itemAndAdapter(id: string) {
  const item = get().inbox.find((i) => i.id === id);
  if (!item) throw new Error("That message is gone.");
  const adapter = get().adapters[item.platform];
  if (!adapter) throw new Error(`${PLATFORM_LABEL[item.platform]} isn't connected.`);
  return { item, adapter };
}

/** Reply publicly (comments) or in the conversation (DMs). Throws so the UI keeps your text. */
export async function replyTo(id: string, text: string): Promise<void> {
  const { item, adapter } = itemAndAdapter(id);
  if (!canReply(item)) throw new Error("The 24-hour reply window has closed.");
  await adapter.reply(item, text);
  const at = nowIso();
  patchItem(id, (i) => ({ thread: [...i.thread, { id: newId(), text, at, fromMe: true }], status: "done", resolvedAt: at }));
}

export async function privateReplyTo(id: string, text: string): Promise<void> {
  const { item, adapter } = itemAndAdapter(id);
  if (!adapter.privateReply || !canPrivateReply(item)) throw new Error("A private reply isn't available for this comment.");
  await adapter.privateReply(item, text);
  patchItem(id, { privateReplySent: true, status: "done", resolvedAt: nowIso() });
}

export function markDone(id: string) {
  patchItem(id, { status: "done", resolvedAt: nowIso() });
}

export function reopen(id: string) {
  patchItem(id, { status: "open", resolvedAt: undefined });
}

export async function hideComment(id: string): Promise<void> {
  const { item, adapter } = itemAndAdapter(id);
  await adapter.hide(item);
  patchItem(id, { status: "hidden", resolvedAt: nowIso() });
}

// ---------- Work ----------

export async function loadWork(force = false): Promise<void> {
  const { work, adapters } = get();
  if (work.loading || (!force && work.fetchedAt && Date.now() - work.fetchedAt < WORK_FRESH_MS)) return;
  set({ work: { ...work, loading: true } });
  const errors: Partial<Record<PlatformId, string>> = {};
  const lists = await Promise.all(
    (Object.values(adapters) as NonNullable<Adapters[PlatformId]>[]).map(async (a) => {
      try {
        return await a.listMyPosts(25);
      } catch (err) {
        errors[a.id] = errorMessage(err);
        return [];
      }
    }),
  );
  set({ work: { posts: lists.flat(), fetchedAt: Date.now(), loading: false, errors } });
}

/** Keep Work's numbers in step after opening a post's detail. */
export function updatePostStats(post: RemotePost, stats: RemotePost["stats"]) {
  const { work } = get();
  set({
    work: {
      ...work,
      posts: work.posts.map((p) => (p.platform === post.platform && p.remoteId === post.remoteId ? { ...p, stats } : p)),
    },
  });
}

// ---------- People ----------

export async function sendMessageTo(person: PersonRef, text: string): Promise<void> {
  const adapter = get().adapters[person.platform];
  if (!adapter?.sendMessage) throw new Error(`${PLATFORM_LABEL[person.platform]} doesn't allow messages from apps.`);
  await adapter.sendMessage(person, text);
  appendToConversation(person, text);
}

export async function sendPostTo(person: PersonRef, post: RemotePost, note: string): Promise<void> {
  const adapter = get().adapters[person.platform];
  if (!adapter?.sendPost) throw new Error(`${PLATFORM_LABEL[person.platform]} can't send posts from apps.`);
  await adapter.sendPost(person, post, note);
  appendToConversation(person, [note.trim(), `Shared: ${post.caption.split("\n")[0] || "your post"}`].filter(Boolean).join("\n"));
}

function appendToConversation(person: PersonRef, text: string) {
  const at = nowIso();
  const conv = get().inbox.find((i) => i.kind === "dm" && i.platform === person.platform && i.person.id === person.id);
  if (conv) patchItem(conv.id, (i) => ({ thread: [...i.thread, { id: newId(), text, at, fromMe: true }], status: "done", resolvedAt: at }));
}
