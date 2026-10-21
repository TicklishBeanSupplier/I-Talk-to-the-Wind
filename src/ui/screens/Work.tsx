import { useEffect, useMemo, useState } from "react";
import { canReply, samePerson } from "../../core/inbox";
import { dayAndTime, relativeTime } from "../../core/schedule";
import type { InboxItem, PersonRef, PlatformId, PostPeople, PostStats, RemotePost, WorkItem } from "../../core/types";
import { PLATFORM_LABEL } from "../../core/types";
import { groupWork } from "../../core/work";
import { errorMessage } from "../../platforms/types";
import { loadWork, navigate, sendPostTo, toast, updatePostStats, useApp } from "../../app/store";
import { Avatar, Btn, fmtCount, Segmented, Thumb, useAction, useNow } from "../kit";
import { Layout } from "../Layout";
import { MediaThumb } from "./Studio";

export function WorkScreen({ selectedKey }: { selectedKey?: string }) {
  const drafts = useApp((s) => s.drafts);
  const work = useApp((s) => s.work);
  const items = useMemo(() => groupWork(drafts, work.posts), [drafts, work.posts]);
  const selected = items.find((i) => i.key === selectedKey) ?? items[0];

  useEffect(() => {
    void loadWork();
  }, []);

  return (
    <Layout label="Work" rail={<WorkRail items={items} selectedKey={selected?.key} />}>
      {selected ? <WorkDetail key={selected.key} item={selected} />
        : work.loading ? <div className="empty"><span className="spin" aria-label="Loading your posts" /></div>
        : <div className="empty" style={{ minHeight: "80%" }}><h2 className="h1">No posts yet</h2><p>Once you post, your work and its numbers show up here.</p></div>}
    </Layout>
  );
}

// ---------- Rail ----------

function WorkRail({ items, selectedKey }: { items: WorkItem[]; selectedKey?: string }) {
  const { loading, errors, fetchedAt } = useApp((s) => s.work);
  const now = useNow(60_000);
  return (
    <>
      <div className="rail-pad">
        <h1 className="mega sm">WORK</h1>
        <p className="rail-sub">Your posts only. Numbers stay here.</p>
      </div>
      <div className="rail-scroll">
        {items.map((w) => (
          <button key={w.key} type="button" className="rail-item" aria-current={w.key === selectedKey ? "true" : undefined} onClick={() => navigate({ screen: "work", key: w.key })}>
            <ItemThumb item={w} size={52} />
            <span className="stack">
              <span className="title">{w.title}</span>
              <span className="meta">{relativeTime(w.at, now)} · {w.posts.map((p) => ({ instagram: "IG", facebook: "FB", youtube: "YT" })[p.platform]).join(", ")}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="rail-foot">
        {Object.entries(errors).map(([p, e]) => <p key={p} className="small" style={{ margin: 0 }}>⚠ {PLATFORM_LABEL[p as PlatformId]}: {e}</p>)}
        <div className="row">
          <Btn small variant="on-panel-soft" icon="refresh" busy={loading} onClick={() => void loadWork(true)}>Refresh</Btn>
          {fetchedAt && <span className="small" style={{ color: "var(--on-panel-muted)" }}>Updated {relativeTime(new Date(fetchedAt).toISOString(), now)}</span>}
        </div>
      </div>
    </>
  );
}

function ItemThumb({ item, size }: { item: WorkItem; size: number }) {
  const draft = useApp((s) => (item.draftId ? s.drafts.find((d) => d.id === item.draftId) : undefined));
  if (item.thumbUrl || !draft) return <Thumb src={item.thumbUrl} alt="" size={size} />;
  return <MediaThumb media={draft.media[0]} size={size} />;
}

// ---------- Detail ----------

interface Detail {
  stats: Partial<Record<PlatformId, PostStats>>;
  people: { commenters: (PostPeople["commenters"][number] & { platform: PlatformId })[]; reactors: PersonRef[] };
  loading: boolean;
}

function usePostDetail(item: WorkItem): Detail {
  const adapters = useApp((s) => s.adapters);
  const [detail, setDetail] = useState<Detail>({ stats: {}, people: { commenters: [], reactors: [] }, loading: true });

  useEffect(() => {
    let live = true;
    Promise.all(
      item.posts.map(async (post) => {
        const a = adapters[post.platform];
        if (!a) return null;
        try {
          const d = await a.postDetail(post);
          updatePostStats(post, d.stats);
          return { post, ...d };
        } catch (err) {
          toast(`${PLATFORM_LABEL[post.platform]}: ${errorMessage(err)}`, "error");
          return null;
        }
      }),
    ).then((results) => {
      if (!live) return;
      const next: Detail = { stats: {}, people: { commenters: [], reactors: [] }, loading: false };
      for (const r of results) {
        if (!r) continue;
        next.stats[r.post.platform] = r.stats;
        next.people.commenters.push(...r.people.commenters.map((c) => ({ ...c, platform: r.post.platform })));
        next.people.reactors.push(...(r.people.reactors ?? []));
      }
      next.people.commenters.sort((a, b) => b.at.localeCompare(a.at));
      setDetail(next);
    });
    return () => {
      live = false;
    };
  }, [item.key, adapters]); // eslint-disable-line react-hooks/exhaustive-deps

  return detail;
}

const STAT_LABELS: [keyof PostStats, string][] = [["likes", "likes"], ["comments", "comments"], ["saves", "saves"], ["shares", "shares"], ["views", "views"]];

function WorkDetail({ item }: { item: WorkItem }) {
  const rt = useApp((s) => s.rt);
  const detail = usePostDetail(item);
  const [tab, setTab] = useState<"commented" | "reacted">("commented");
  const hasFacebook = item.posts.some((p) => p.platform === "facebook");
  const hasInstagram = item.posts.some((p) => p.platform === "instagram");

  return (
    <div className="stage-inner">
      <div className="stage-split">
        <div className="main">
          <div className="row" style={{ gap: 20, flexWrap: "nowrap" }}>
            <ItemThumb item={item} size={140} />
            <div className="col" style={{ gap: 6, minWidth: 0 }}>
              <h2 className="h1">{item.title}</h2>
              <p className="muted" style={{ margin: 0 }}>Posted {dayAndTime(item.at)} to {item.posts.map((p) => PLATFORM_LABEL[p.platform]).join(" and ")}</p>
              <div className="row" style={{ gap: 6 }}>
                {item.posts.filter((p) => p.permalink).map((p) => (
                  <Btn key={p.platform} small icon="copy" onClick={() => rt?.copyText(p.permalink!).then(() => toast("Link copied.", "success"))}>
                    {item.posts.length > 1 ? `${PLATFORM_LABEL[p.platform]} link` : "Copy link"}
                  </Btn>
                ))}
              </div>
            </div>
          </div>

          <div className="grid2">
            {item.posts.map((p) => {
              const stats = detail.stats[p.platform] ?? p.stats;
              const shown = STAT_LABELS.filter(([k]) => stats[k] !== undefined);
              return (
                <div key={p.platform} className="card col" style={{ padding: 18, boxShadow: `inset 0 3px 0 var(--${p.platform === "instagram" ? "ig" : p.platform === "facebook" ? "fb" : "yt"})` }}>
                  <span className="label">{PLATFORM_LABEL[p.platform]}</span>
                  <div className="row" style={{ gap: 22 }}>
                    {shown.length ? shown.map(([k, label]) => (
                      <div key={k} className="col" style={{ gap: 2 }}>
                        <span className="num">{fmtCount(stats[k])}</span>
                        <span className="small muted">{p.platform === "facebook" && k === "likes" ? "reactions" : label}</span>
                      </div>
                    )) : <span className="muted small">{detail.loading ? "Loading…" : "No numbers yet"}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <section className="col" aria-label="People">
            <div className="row">
              <Segmented label="People who" value={hasFacebook ? tab : "commented"} onChange={setTab}
                options={[
                  { value: "commented", label: `Commented · ${detail.people.commenters.length}` },
                  ...(hasFacebook ? [{ value: "reacted" as const, label: `Reacted on Facebook · ${detail.people.reactors.length}` }] : []),
                ]} />
            </div>
            {hasInstagram && <p className="hint">Instagram shares how many people liked a post, but not who.</p>}
            {detail.loading ? <span className="spin" aria-label="Loading people" style={{ color: "var(--panel)" }} />
              : tab === "reacted" && hasFacebook ? <PeopleList people={detail.people.reactors.map((person) => ({ person, platform: "facebook" as PlatformId }))} />
              : <PeopleList people={detail.people.commenters.map((c) => ({ person: c.person, platform: c.platform, text: c.text }))} />}
          </section>
        </div>

        <aside className="side">
          <SendPostPanel item={item} />
        </aside>
      </div>
    </div>
  );
}

function PeopleList({ people }: { people: { person: PersonRef; platform: PlatformId; text?: string }[] }) {
  const inbox = useApp((s) => s.inbox);
  if (!people.length) return <p className="muted">Nobody yet.</p>;
  return (
    <div className="list">
      {people.slice(0, 100).map(({ person, platform, text }, i) => {
        const canDm = inbox.some((x) => x.kind === "dm" && samePerson(x.person, person) && canReply(x));
        return (
          <div key={`${person.id ?? person.username ?? person.name}-${i}`} className="list-row">
            <Avatar person={person} size={40} />
            <div className="col" style={{ flex: 1, minWidth: 180, gap: 2 }}>
              <span><strong>{person.username ?? person.name}</strong> <span className="muted">· {PLATFORM_LABEL[platform]}</span></span>
              {text && <span className="small muted" style={{ overflowWrap: "anywhere" }}>“{text}”</span>}
            </div>
            {canDm && <span className="chip go">Can DM</span>}
            <Btn small onClick={() => navigate({ screen: "person", person })}>Profile</Btn>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Send this post ----------

function SendPostPanel({ item }: { item: WorkItem }) {
  const inbox = useApp((s) => s.inbox);
  const adapters = useApp((s) => s.adapters);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const { busy, run } = useAction();
  const now = useNow();

  // People you may message right now, on a platform where this post exists.
  const candidates = useMemo(() => {
    const byPlatform = new Map(item.posts.map((p) => [p.platform, p]));
    const seen = new Set<string>();
    return inbox
      .filter((i): i is InboxItem => i.kind === "dm" && byPlatform.has(i.platform) && !!adapters[i.platform]?.sendPost && canReply(i, now))
      .filter((i) => (seen.has(i.remoteId) ? false : (seen.add(i.remoteId), true)))
      .map((i) => ({ item: i, post: byPlatform.get(i.platform)! as RemotePost }));
  }, [inbox, adapters, item.posts, now]);

  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const send = () =>
    run("send", async () => {
      const chosen = candidates.filter((c) => picked.has(c.item.id));
      const failures: string[] = [];
      for (const c of chosen) {
        try {
          await sendPostTo(c.item.person, c.post, note);
        } catch (err) {
          failures.push(`${c.item.person.name}: ${errorMessage(err)}`);
        }
      }
      if (failures.length) throw new Error(failures.join(" · "));
      setPicked(new Set());
      setNote("");
    }, `Sent to ${picked.size} ${picked.size === 1 ? "person" : "people"}.`);

  if (!item.posts.some((p) => adapters[p.platform]?.sendPost)) {
    return <div className="card"><h3 className="h2">Send this post</h3><p className="muted">YouTube doesn't have messages, so this one can't be sent from here. Copy the link instead.</p></div>;
  }

  return (
    <div className="card col" style={{ gap: 14 }}>
      <h3 className="h2">Send this post</h3>
      <p className="hint">You can send it to anyone who messaged you in the last 24 hours. That's Meta's rule.</p>
      {candidates.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nobody has an open conversation with you right now.</p> : (
        <div className="col" style={{ gap: 2 }}>
          {candidates.map(({ item: c }) => (
            <label key={c.id} className="row" style={{ padding: "8px 2px", flexWrap: "nowrap", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 20, height: 20, accentColor: "var(--accent)" }} />
              <span className="col" style={{ gap: 0 }}>
                <strong>{c.person.name}</strong>
                <span className="small muted">{PLATFORM_LABEL[c.platform]} · open {relativeTime(c.replyWindowEndsAt!, now).replace("in ", "")}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <label className="field">
        <span>Add a note (optional)</span>
        <textarea className="textarea" rows={2} style={{ minHeight: 64 }} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <Btn variant="accent" busy={busy === "send"} disabled={picked.size === 0} onClick={() => void send()}>
        Send to {picked.size || ""} {picked.size === 1 ? "person" : "people"}
      </Btn>
      {item.posts.map((p) => <PlatformNote key={p.platform} platform={p.platform} />)}
    </div>
  );
}

function PlatformNote({ platform }: { platform: PlatformId }) {
  if (platform === "facebook") return <p className="hint">On Facebook it's sent as a link.</p>;
  return null;
}

