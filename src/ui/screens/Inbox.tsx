import { useEffect, useMemo, useRef, useState } from "react";
import { canPrivateReply, canReply, historyWith } from "../../core/inbox";
import { clockTime, nextCheckTime, relativeTime } from "../../core/schedule";
import type { InboxItem, PersonRef } from "../../core/types";
import { PLATFORM_LABEL } from "../../core/types";
import {
  hideComment, markDone, navigate, privateReplyTo, reopen, replyTo, syncInbox, useApp,
} from "../../app/store";
import { Avatar, Btn, fmtCount, Icon, PlatformChip, Progress, Segmented, Thumb, useAction, useNow } from "../kit";
import { Layout } from "../Layout";
import { useProfile } from "../people";

type Filter = "all" | "comment" | "dm";
const KIND_LABEL = (i: InboxItem) => (i.kind === "comment" ? "Comment" : i.storyReply ? "Story reply" : "Message");

// The session timer survives hopping to a person and back; it resets after a real break.
const session = { startedAt: 0, extraMs: 0, lastSeen: 0 };
const BREAK_MS = 15 * 60_000;

export function InboxScreen({ itemId }: { itemId?: string }) {
  const inbox = useApp((s) => s.inbox);
  const [filter, setFilter] = useState<Filter>("all");
  const open = useMemo(() => inbox.filter((i) => i.status === "open" && (filter === "all" || i.kind === filter)), [inbox, filter]);
  // Keep showing an item you just finished until you move on.
  const selected = inbox.find((i) => i.id === itemId) ?? open[0];

  const next = (fromId: string) => {
    const rest = open.filter((i) => i.id !== fromId);
    const idx = open.findIndex((i) => i.id === fromId);
    const target = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
    navigate({ screen: "inbox", itemId: target?.id });
  };

  return (
    <Layout label="Inbox" rail={<InboxRail items={open} selectedId={selected?.id} filter={filter} setFilter={setFilter} />}>
      <Timebox />
      {selected ? <ItemView key={selected.id} item={selected} onNext={() => next(selected.id)} /> : <AllClear />}
    </Layout>
  );
}

// ---------- Rail ----------

function InboxRail({ items, selectedId, filter, setFilter }: { items: InboxItem[]; selectedId?: string; filter: Filter; setFilter: (f: Filter) => void }) {
  const times = useApp((s) => s.settings.inboxCheckTimes);
  const syncing = useApp((s) => s.syncing);
  const syncErrors = useApp((s) => s.syncErrors);
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const now = useNow();
  const nextAt = nextCheckTime(times, now);

  return (
    <>
      <div className="rail-pad">
        <h1 className="mega">{String(items.length).padStart(2, "0")}</h1>
        <p className="rail-sub">
          to answer{nextAt ? ` · next check ${clockTime(nextAt)}` : ""}
        </p>
        <div className="row" style={{ gap: 6 }} role="group" aria-label="Show">
          {(["all", "comment", "dm"] as Filter[]).map((f) => (
            <button key={f} type="button" className={`btn sm ${filter === f ? "on-panel" : "on-panel-soft"}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "Everything" : f === "comment" ? "Comments" : "Messages"}
            </button>
          ))}
        </div>
      </div>
      <div className="rail-scroll" style={{ marginTop: 14 }}>
        {items.map((i) => (
          <button key={i.id} type="button" className="rail-item" aria-current={i.id === selectedId ? "true" : undefined} onClick={() => navigate({ screen: "inbox", itemId: i.id })}>
            <span className="stack">
              <span className={`eyebrow ${i.platform}`}>{PLATFORM_LABEL[i.platform]} · {KIND_LABEL(i)} · {relativeTime(i.at, now)}</span>
              <span className="title"><strong>{i.person.name}:</strong> {i.text}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="rail-foot">
        {Object.entries(syncErrors).map(([p, e]) => (
          <p key={p} className="small" style={{ margin: 0, color: "var(--on-panel)" }}>⚠ {PLATFORM_LABEL[p as keyof typeof PLATFORM_LABEL]}: {e}</p>
        ))}
        <div className="row">
          <Btn variant="on-panel-soft" small icon="refresh" busy={syncing} onClick={() => void syncInbox()}>Check now</Btn>
          <span className="small" style={{ color: "var(--on-panel-muted)" }}>{lastSyncAt ? `Checked ${relativeTime(lastSyncAt, now)}` : "Not checked yet"}</span>
        </div>
      </div>
    </>
  );
}

// ---------- Session time box ----------

function Timebox() {
  const minutes = useApp((s) => s.settings.inboxTimeboxMinutes);
  const now = useNow(5_000);
  const [, bump] = useState(0);

  // Start (or restart after a real break) when the inbox is opened.
  useEffect(() => {
    const t = Date.now();
    if (!session.startedAt || t - session.lastSeen > BREAK_MS) Object.assign(session, { startedAt: t, extraMs: 0 });
    session.lastSeen = t;
    bump((n) => n + 1); // draw the bar right away
    return () => {
      session.lastSeen = Date.now();
    };
  }, []);

  if (!minutes || !session.startedAt) return null;
  const t = now.getTime();
  const total = minutes * 60_000 + session.extraMs;
  const left = Math.max(0, total - (t - session.startedAt));

  if (left > 0) {
    return (
      <div className="row" style={{ position: "sticky", top: 0, zIndex: 5, padding: "14px 40px 0", gap: 12 }}>
        <span className="spacer" />
        <div style={{ width: 120 }}><Progress value={left / total} label="Time left this session" /></div>
        <span className="small muted"><Icon name="clock" size={13} /> {Math.ceil(left / 60_000)} min left</span>
      </div>
    );
  }
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="timeup">
      <div className="card col" style={{ maxWidth: 420, textAlign: "center", alignItems: "center", gap: 14 }}>
        <h2 className="h1" id="timeup">Time's up.</h2>
        <p className="muted" style={{ margin: 0 }}>The rest will keep until the next check.</p>
        <div className="row">
          <Btn variant="primary" onClick={() => navigate({ screen: "studio" })}>Close the inbox</Btn>
          <Btn onClick={() => { session.extraMs += 5 * 60_000; bump((n) => n + 1); }}>5 more minutes</Btn>
        </div>
      </div>
    </div>
  );
}

// ---------- One item ----------

function ItemView({ item, onNext }: { item: InboxItem; onNext: () => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"public" | "private">("public");
  const [showCard, setShowCard] = useState(true);
  const { busy, run } = useAction();
  const now = useNow();
  const area = useRef<HTMLTextAreaElement>(null);
  const supportsPrivate = !!useApp((s) => s.adapters[item.platform]?.privateReply);

  const windowOpen = canReply(item, now);
  const privateOk = supportsPrivate && canPrivateReply(item, now);
  const resolved = item.status !== "open";

  useEffect(() => area.current?.focus(), []);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const ok = await run("send", () => (mode === "private" ? privateReplyTo(item.id, body) : replyTo(item.id, body)));
    if (ok) {
      setText("");
      onNext();
    }
  };

  return (
    <div className="stage-inner">
      <div className="stage-split">
        <div className="main">
          <div className="row">
            <PlatformChip platform={item.platform} />
            <span className="chip lime">{KIND_LABEL(item)}</span>
            {item.kind === "dm" && item.replyWindowEndsAt && (
              windowOpen
                ? <span className="chip go">Reply open {relativeTime(item.replyWindowEndsAt, now).replace("in ", "")} more</span>
                : <span className="chip danger">Reply window closed</span>
            )}
            {resolved && <span className="chip">{item.status === "hidden" ? "Hidden" : "Done"}</span>}
            <span className="spacer" />
            <span className="small muted">{relativeTime(item.at, now)}</span>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <button type="button" className="btn ghost" style={{ alignSelf: "flex-start", padding: 0, minHeight: 40, fontSize: 26, fontWeight: 800, fontStretch: "112%", color: "var(--ink)", textDecoration: "underline", textDecorationColor: "var(--chip)", textUnderlineOffset: 6 }}
              aria-expanded={showCard} aria-controls="profile-card" onClick={() => setShowCard((v) => !v)}>
              {item.person.name}
            </button>
            {item.kind === "dm" ? <Thread item={item} /> : <p className="big-quote">{item.text}</p>}
          </div>

          {item.kind === "comment" && item.context && (
            <div className="well row" style={{ padding: 10 }}>
              <Thumb src={item.context.thumbUrl} alt="" size={56} />
              <span className="small muted">On your post <strong style={{ color: "var(--ink)" }}>{item.context.postTitle ?? "(untitled)"}</strong></span>
            </div>
          )}
          {item.kind === "comment" && item.thread.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <p className="label">Replies</p>
              {item.thread.map((m) => <div key={m.id} className={`bubble ${m.fromMe ? "mine" : "theirs"}`}>{m.text}</div>)}
            </div>
          )}

          {resolved ? (
            <div className="row">
              <Btn onClick={() => reopen(item.id)}>Move back to “to answer”</Btn>
              <Btn variant="primary" onClick={onNext}>Next</Btn>
            </div>
          ) : (
            <>
              {item.kind === "comment" && privateOk && (
                <Segmented label="Reply type" value={mode} onChange={setMode}
                  options={[{ value: "public", label: "Public reply" }, { value: "private", label: "Private message" }]} />
              )}
              <label className="field">
                <span>{mode === "private" ? `Private message to ${item.person.name} (one per comment)` : item.kind === "dm" ? "Your reply" : "Your public reply"}</span>
                <textarea ref={area} className="textarea big" rows={4} value={text} disabled={!windowOpen && mode === "public"}
                  placeholder={windowOpen ? "" : "Meta only allows replies within 24 hours of their last message."}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
              </label>
              <div className="row">
                <Btn variant="primary" busy={busy === "send"} disabled={!text.trim() || (!windowOpen && mode === "public")} onClick={() => void send()}>
                  {mode === "private" ? "Send privately" : "Send and next"}
                </Btn>
                <Btn onClick={() => { markDone(item.id); onNext(); }}>Done, no reply</Btn>
                {item.kind === "comment" && (
                  <Btn variant="ghost" busy={busy === "hide"} onClick={() => run("hide", () => hideComment(item.id), "Comment hidden.").then((ok) => ok && onNext())}>Hide comment</Btn>
                )}
                <Btn variant="ghost" onClick={onNext}>Skip</Btn>
              </div>
              <p className="hint">Tip: Ctrl/⌘ + Enter sends.</p>
            </>
          )}
        </div>

        {showCard && (
          <aside className="side" id="profile-card">
            <ProfileCard person={item.person} onClose={() => setShowCard(false)} />
          </aside>
        )}
      </div>
    </div>
  );
}

function Thread({ item }: { item: InboxItem }) {
  const recent = item.thread.slice(-8);
  return (
    <div className="col" style={{ gap: 8 }}>
      {recent.map((m) => <div key={m.id} className={`bubble ${m.fromMe ? "mine" : "theirs"}`}>{m.text}</div>)}
    </div>
  );
}

// ---------- Profile card ----------

export function ProfileCard({ person, onClose }: { person: PersonRef; onClose?: () => void }) {
  const rt = useApp((s) => s.rt);
  const inbox = useApp((s) => s.inbox);
  const { profile, loading } = useProfile(person);
  const history = useMemo(() => historyWith(inbox, person), [inbox, person]);
  const p = profile ?? { ...person, postsVisible: false };

  return (
    <div className="card col" style={{ gap: 16 }}>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <Avatar person={p} url={p.avatarUrl} size={60} />
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <strong style={{ fontSize: 19 }}>{p.name}</strong>
          {p.username && <span className="muted small">@{p.username}</span>}
        </div>
        <span className="spacer" />
        {onClose && <button type="button" className="btn soft sm" aria-label="Close profile" onClick={onClose} style={{ width: 36, padding: 0 }}><Icon name="x" size={14} /></button>}
      </div>
      {loading ? <span className="spin" aria-label="Loading profile" style={{ color: "var(--panel)" }} /> : (
        <>
          <div className="row" style={{ gap: 6 }}>
            {p.followsYou && <span className="chip go">Follows you</span>}
            {p.youFollow && <span className="chip">You follow them</span>}
            {p.followers !== undefined && <span className="chip">{fmtCount(p.followers)} {person.platform === "youtube" ? "subscribers" : "followers"}</span>}
          </div>
          {p.bio && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{p.bio}</p>}
        </>
      )}
      <div className="col" style={{ gap: 8, borderTop: "1px solid var(--well)", paddingTop: 14 }}>
        <p className="label">With you</p>
        <div className="grid3">
          {[["messages", history.messages], ["comments", history.comments], ["story replies", history.storyReplies]].map(([label, n]) => (
            <div key={label} className="well col" style={{ gap: 2, padding: 10 }}>
              <span className="num" style={{ fontSize: 22 }}>{n}</span>
              <span className="small muted">{label}</span>
            </div>
          ))}
        </div>
        {history.lastCommentOn && <p className="small muted" style={{ margin: 0 }}>Last commented on “{history.lastCommentOn}”.</p>}
      </div>
      <div className="col" style={{ gap: 8 }}>
        <Btn variant="accent" onClick={() => navigate({ screen: "person", person })}>Open person</Btn>
        {p.profileUrl && (
          <>
            <Btn icon="out" onClick={() => void rt?.openExternal(p.profileUrl!)}>Open full profile</Btn>
            <p className="hint" style={{ textAlign: "center" }}>Opens {new URL(p.profileUrl).hostname.replace("www.", "")} in your browser</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Empty ----------

function AllClear() {
  const times = useApp((s) => s.settings.inboxCheckTimes);
  const syncing = useApp((s) => s.syncing);
  const connected = useApp((s) => Object.keys(s.adapters).length > 0);
  const nextAt = nextCheckTime(times);
  return (
    <div className="empty" style={{ minHeight: "80%" }}>
      <h2 className="h1">All clear.</h2>
      <p style={{ maxWidth: 420 }}>
        {connected ? `Nothing needs you${nextAt ? ` until the next check at ${clockTime(nextAt)}` : ""}.` : "Connect your accounts in Settings and comments and messages will gather here."}
      </p>
      {connected ? <Btn icon="refresh" busy={syncing} onClick={() => void syncInbox()}>Check now</Btn>
        : <Btn variant="primary" onClick={() => navigate({ screen: "settings" })}>Open Settings</Btn>}
    </div>
  );
}
