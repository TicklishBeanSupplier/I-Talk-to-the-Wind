import { useEffect, useMemo, useState } from "react";
import { canPrivateReply, historyWith, openConversationWith, samePerson } from "../../core/inbox";
import { relativeTime } from "../../core/schedule";
import type { PersonProfile, PersonRef, RemotePost, TheirPost } from "../../core/types";
import { PLATFORM_LABEL } from "../../core/types";
import { errorMessage } from "../../platforms/types";
import { back, loadWork, privateReplyTo, sendMessageTo, sendPostTo, useApp } from "../../app/store";
import { Avatar, Btn, fmtCount, Icon, Thumb, useAction, useNow } from "../kit";
import { Layout } from "../Layout";
import { forgetProfile, useProfile } from "../people";

export function PersonScreen({ person }: { person: PersonRef }) {
  const [version, setVersion] = useState(0);
  const { profile, loading } = useProfile(person, version);
  const p: PersonProfile = profile ?? { ...person, postsVisible: false };
  const refresh = () => {
    forgetProfile(person);
    setVersion((v) => v + 1);
  };

  return (
    <Layout label={p.name} rail={<PersonRail profile={p} loading={loading} onFollowed={refresh} />}>
      <div className="stage-inner col" style={{ gap: 28 }}>
        <MessageSection person={p} />
        <TheirPosts profile={p} loading={loading} />
      </div>
    </Layout>
  );
}

// ---------- Rail ----------

function PersonRail({ profile: p, loading, onFollowed }: { profile: PersonProfile; loading: boolean; onFollowed: () => void }) {
  const rt = useApp((s) => s.rt);
  const inbox = useApp((s) => s.inbox);
  const canFollowInApp = useApp((s) => !!s.adapters[p.platform]?.follow);
  const history = useMemo(() => historyWith(inbox, p), [inbox, p]);
  const { busy, run } = useAction();

  const follow = () =>
    run("follow", async () => {
      await useApp.getState().adapters[p.platform]!.follow!(p);
      onFollowed();
    }, `Subscribed to ${p.name}.`);

  return (
    <div className="rail-scroll rail-pad" style={{ gap: 16 }}>
      <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start", color: "var(--on-panel-muted)", paddingLeft: 0 }} onClick={back}>
        <Icon name="back" size={14} /> Back
      </button>
      <Avatar person={p} url={p.avatarUrl} size={88} />
      <div className="col" style={{ gap: 4 }}>
        <h1 className="h1" style={{ fontSize: 36 }}>{p.name}</h1>
        <p style={{ margin: 0, color: "var(--on-panel-muted)" }}>{p.username ? `@${p.username} · ` : ""}{PLATFORM_LABEL[p.platform]}</p>
      </div>
      {loading ? <span className="spin" aria-label="Loading profile" /> : (
        <>
          {p.bio && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{p.bio}</p>}
          <div className="row" style={{ gap: 6 }}>
            {p.followsYou && <span className="chip go">Follows you</span>}
            {p.youFollow && <span className="chip" style={{ background: "var(--panel-2)", color: "var(--on-panel)" }}>{p.platform === "youtube" ? "Subscribed" : "You follow them"}</span>}
            {p.followers !== undefined && <span className="chip" style={{ background: "var(--panel-2)", color: "var(--on-panel)" }}>{fmtCount(p.followers)} {p.platform === "youtube" ? "subscribers" : "followers"}</span>}
            {p.postsCount !== undefined && <span className="chip" style={{ background: "var(--panel-2)", color: "var(--on-panel)" }}>{fmtCount(p.postsCount)} {p.platform === "youtube" ? "videos" : "posts"}</span>}
          </div>
        </>
      )}

      <div className="col" style={{ gap: 8 }}>
        {canFollowInApp ? (
          !p.youFollow && <Btn variant="on-panel" busy={busy === "follow"} onClick={() => void follow()}>Subscribe</Btn>
        ) : p.profileUrl ? (
          <>
            <Btn variant="on-panel" icon="out" onClick={() => void rt?.openExternal(p.profileUrl!)}>{p.youFollow ? "Open profile" : `Follow on ${PLATFORM_LABEL[p.platform]}`}</Btn>
            {!p.youFollow && <p className="small" style={{ margin: 0, color: "var(--on-panel-muted)", textAlign: "center" }}>{PLATFORM_LABEL[p.platform]} doesn't let apps follow for you, so this opens their profile.</p>}
          </>
        ) : null}
      </div>

      <div className="col" style={{ gap: 10, background: "var(--panel-2)", borderRadius: 20, padding: 16 }}>
        <p className="label" style={{ color: "var(--on-panel-muted)" }}>With you</p>
        <div className="grid3">
          {[["messages", history.messages], ["comments", history.comments], ["story replies", history.storyReplies]].map(([label, n]) => (
            <div key={label} className="col" style={{ gap: 0 }}>
              <span className="num" style={{ fontSize: 24 }}>{n}</span>
              <span className="small" style={{ color: "var(--on-panel-muted)" }}>{label}</span>
            </div>
          ))}
        </div>
        {history.firstAt && <p className="small" style={{ margin: 0, color: "var(--on-panel-muted)" }}>First reached out {relativeTime(history.firstAt)}.</p>}
      </div>
    </div>
  );
}

// ---------- Messaging ----------

function MessageSection({ person }: { person: PersonProfile }) {
  const inbox = useApp((s) => s.inbox);
  const hasDms = useApp((s) => !!s.adapters[person.platform]?.capabilities.dms);
  const now = useNow();
  const conversation = openConversationWith(inbox, person, now);
  const commentForPrivate = inbox.find((i) => i.kind === "comment" && samePerson(i.person, person) && canPrivateReply(i, now));
  const [text, setText] = useState("");
  const { busy, run } = useAction();

  if (!hasDms) {
    return (
      <section className="card col">
        <h2 className="h2">Messages</h2>
        <p className="muted" style={{ margin: 0 }}>{PLATFORM_LABEL[person.platform]} doesn't have direct messages. Reply to their comments from the Inbox.</p>
      </section>
    );
  }

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const ok = await run("send", () => (conversation ? sendMessageTo(conversation.person, body) : privateReplyTo(commentForPrivate!.id, body)), "Sent.");
    if (ok) setText("");
  };

  if (!conversation && !commentForPrivate) {
    return (
      <section className="card col">
        <h2 className="h2">Message {person.name}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {PLATFORM_LABEL[person.platform]} only lets apps write to people who messaged you in the last 24 hours, or send one private reply to someone who commented on your post. Neither applies right now.
        </p>
      </section>
    );
  }

  return (
    <section className="card col" style={{ gap: 14, boxShadow: "0 0 0 2px var(--accent)" }}>
      <div className="row">
        <h2 className="h2" style={{ marginRight: "auto" }}>Message {person.name}</h2>
        {conversation
          ? <span className="chip go">Conversation open · {relativeTime(conversation.replyWindowEndsAt!, now).replace("in ", "")} left</span>
          : <span className="chip warn">One private reply available</span>}
      </div>
      {conversation ? (
        <div className="col" style={{ gap: 8 }}>
          {conversation.thread.slice(-6).map((m) => <div key={m.id} className={`bubble ${m.fromMe ? "mine" : "theirs"}`}>{m.text}</div>)}
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>They commented “{commentForPrivate!.text}” on {commentForPrivate!.context?.postTitle ?? "your post"}. Meta allows one private message about it.</p>
      )}
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
        <label className="sr-only" htmlFor="person-msg">Message</label>
        <textarea id="person-msg" className="textarea" rows={2} style={{ minHeight: 60, flex: 1 }} placeholder="Write a message" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <Btn variant="accent" busy={busy === "send"} disabled={!text.trim()} onClick={() => void send()}>Send</Btn>
      </div>
      {conversation && <SendAPost person={conversation.person} />}
    </section>
  );
}

/** Pick one of your posts on this platform and send it into the conversation. */
function SendAPost({ person }: { person: PersonRef }) {
  const posts = useApp((s) => s.work.posts);
  const loadingWork = useApp((s) => s.work.loading);
  const canSend = useApp((s) => !!s.adapters[person.platform]?.sendPost);
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const mine = useMemo(() => posts.filter((p) => p.platform === person.platform && p.kind !== "story").slice(0, 12), [posts, person.platform]);

  useEffect(() => {
    if (open) void loadWork();
  }, [open]);

  if (!canSend) return null;
  if (!open) return <Btn style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Send them a post</Btn>;
  const sendIt = (post: RemotePost) => run(post.remoteId, () => sendPostTo(person, post, ""), "Post sent.").then((ok) => ok && setOpen(false));

  return (
    <div className="col" style={{ gap: 10 }}>
      <p className="label">Pick a post to send</p>
      {mine.length === 0 ? <p className="muted small">{loadingWork ? "Loading your posts…" : `No ${PLATFORM_LABEL[person.platform]} posts to send yet.`}</p> : (
        <div className="row" style={{ gap: 8 }}>
          {mine.map((post) => (
            <button key={post.remoteId} type="button" onClick={() => void sendIt(post)} disabled={!!busy} aria-label={`Send ${post.caption.split("\n")[0] || "post"}`}
              style={{ border: 0, padding: 0, background: "none", borderRadius: 10, position: "relative" }}>
              <Thumb src={post.thumbUrl} alt="" size={72} />
              {busy === post.remoteId && <span className="spin" style={{ position: "absolute", inset: 0, margin: "auto", color: "#fff" }} />}
            </button>
          ))}
        </div>
      )}
      <Btn variant="ghost" small style={{ alignSelf: "flex-start" }} onClick={() => setOpen(false)}>Cancel</Btn>
    </div>
  );
}

// ---------- Their posts ----------

function TheirPosts({ profile, loading: profileLoading }: { profile: PersonProfile; loading: boolean }) {
  const rt = useApp((s) => s.rt);
  const adapter = useApp((s) => s.adapters[profile.platform]);
  const [posts, setPosts] = useState<TheirPost[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  const loadPage = async (from?: string) => {
    if (!adapter) return;
    setState("loading");
    try {
      const page = await adapter.theirPosts(profile, from);
      setPosts((prev) => (from ? [...prev, ...page.items] : page.items));
      setCursor(page.cursor);
      setState("idle");
    } catch (err) {
      setError(errorMessage(err));
      setState("error");
    }
  };

  useEffect(() => {
    setPosts([]);
    setCursor(undefined);
    if (!profileLoading && profile.postsVisible) void loadPage();
  }, [profileLoading, profile.postsVisible, profile.id, profile.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <div className="row">
      <h2 className="h1" style={{ fontSize: 26, marginRight: "auto" }}>Their posts</h2>
      {profile.profileUrl && <Btn small variant="ghost" icon="out" onClick={() => void rt?.openExternal(profile.profileUrl!)}>Open on {PLATFORM_LABEL[profile.platform]}</Btn>}
    </div>
  );

  if (profileLoading) return <section className="col">{header}<span className="spin" style={{ color: "var(--panel)" }} aria-label="Loading" /></section>;
  if (!profile.postsVisible) {
    const why = profile.platform === "facebook"
      ? "Facebook doesn't let apps show a person's posts."
      : profile.platform === "instagram"
        ? "Instagram only shows posts to apps for Creator and Business accounts. This one looks personal."
        : "This channel's videos aren't available.";
    return <section className="col">{header}<p className="muted" style={{ margin: 0 }}>{why}</p></section>;
  }

  return (
    <section className="col" aria-label="Their posts">
      {header}
      {state === "error" && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      <div className="grid4">
        {posts.map((t) => (
          <figure key={t.id} className="tile">
            <Thumb src={t.thumbUrl} alt={t.caption ? t.caption.slice(0, 80) : "Their post"} width="100%" />
            <figcaption>{t.kind === "video" ? (t.views !== undefined ? `${fmtCount(t.views)} views` : "Video") : `${fmtCount(t.likes)} likes`}</figcaption>
          </figure>
        ))}
      </div>
      <div className="row">
        <span className="small muted">{posts.length ? `Latest ${posts.length}. No endless scroll.` : state === "loading" ? "" : "No posts to show."}</span>
        {state === "loading" && <span className="spin" style={{ color: "var(--panel)" }} aria-label="Loading" />}
        {cursor && state !== "loading" && <Btn small onClick={() => void loadPage(cursor)}>Show 8 more</Btn>}
      </div>
    </section>
  );
}
