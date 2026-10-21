import { useEffect, useState, type ReactNode } from "react";
import type { PlatformId, Season, Settings } from "../../core/types";
import { PLATFORM_LABEL, PLATFORMS } from "../../core/types";
import { META_REDIRECT_URI, metaFromPageToken, metaLogin, type PageChoice } from "../../platforms/meta/auth";
import { fetchMyChannel } from "../../platforms/youtube/youtube";
import { chooseOutbox, setAccounts, toast, updateSettings, useApp } from "../../app/store";
import { googleAuth, supabaseStaging } from "../../app/services";
import { SECRET_KEYS, type SecretKey } from "../../runtime/types";
import { Btn, Segmented, useAction } from "../kit";
import { Layout } from "../Layout";

const SECTIONS = [
  { id: "accounts", label: "Instagram & Facebook" },
  { id: "youtube", label: "YouTube" },
  { id: "handoff", label: "Photo hand-off" },
  { id: "outbox", label: "Outbox folder" },
  { id: "inbox", label: "Inbox rhythm" },
  { id: "posting", label: "Posting" },
];

export function SettingsScreen() {
  const accounts = useApp((s) => s.accounts);
  const outboxPath = useApp((s) => s.settings.outboxPath);
  const steps = [
    { done: !!accounts.meta, text: "Connect Instagram and Facebook" },
    { done: !!accounts.youtube, text: "Connect YouTube" },
    { done: !!outboxPath, text: "Choose your Outbox folder" },
  ];
  const remaining = steps.filter((s) => !s.done).length;

  return (
    <Layout label="Settings" rail={
      <>
        <div className="rail-pad">
          <h1 className="mega sm">SETUP</h1>
          <p className="rail-sub">{remaining ? `${remaining} step${remaining === 1 ? "" : "s"} left` : "All set."}</p>
          <ul className="col" style={{ listStyle: "none", padding: 0, margin: "0 0 18px", gap: 8 }}>
            {steps.map((s) => (
              <li key={s.text} className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 11, display: "grid", placeItems: "center", background: s.done ? "var(--go)" : "var(--panel-2)", color: "var(--go-ink)", fontSize: 13, fontWeight: 900 }}>{s.done ? "✓" : ""}</span>
                <span style={{ color: s.done ? "var(--on-panel-muted)" : "var(--on-panel)" }}>{s.text}<span className="sr-only">{s.done ? " (done)" : ""}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rail-scroll">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="rail-item" onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth" })}>
              <span className="title">{s.label}</span>
            </button>
          ))}
        </div>
      </>
    }>
      <div className="stage-inner col" style={{ gap: 28, maxWidth: 820 }}>
        <MetaSection />
        <YouTubeSection />
        <HandoffSection />
        <OutboxSection />
        <InboxSection />
        <PostingSection />
      </div>
    </Layout>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card col" style={{ gap: 14, scrollMarginTop: 24 }} aria-labelledby={`${id}-h`}>
      <h2 className="h2" id={`${id}-h`}>{title}</h2>
      {intro && <p className="muted" style={{ margin: 0 }}>{intro}</p>}
      {children}
    </section>
  );
}

/** Text field backed by the system keychain. Shows that a value is saved without revealing it. */
function useSecrets(keys: SecretKey[]) {
  const rt = useApp((s) => s.rt);
  const [saved, setSaved] = useState<Partial<Record<SecretKey, boolean>>>({});
  const [draft, setDraft] = useState<Partial<Record<SecretKey, string>>>({});
  useEffect(() => {
    if (!rt) return;
    void Promise.all(keys.map(async (k) => [k, !!(await rt.secrets.get(k))] as const)).then((pairs) => setSaved(Object.fromEntries(pairs)));
  }, [rt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!rt) return;
    const entries = Object.entries(draft).filter(([, v]) => v && v.trim()) as [SecretKey, string][];
    await Promise.all(entries.map(([k, v]) => rt.secrets.set(k, v.trim())));
    setSaved((s) => ({ ...s, ...Object.fromEntries(entries.map(([k]) => [k, true])) }));
    setDraft({});
  };
  const field = (key: SecretKey, label: string, secret = true) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <input className="input" type={secret ? "password" : "text"} autoComplete="off" spellCheck={false}
        placeholder={saved[key] ? "Saved. Type to replace." : ""} value={draft[key] ?? ""}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
    </label>
  );
  const dirty = Object.values(draft).some((v) => v && v.trim());
  return { saved, save, field, dirty };
}

function PreviewNote() {
  const preview = useApp((s) => s.rt?.kind === "preview");
  return preview ? <p className="chip warn" style={{ margin: 0, alignSelf: "flex-start" }}>Preview mode: logins work in the desktop app.</p> : null;
}

// ---------- Meta ----------

function MetaSection() {
  const rt = useApp((s) => s.rt);
  const accounts = useApp((s) => s.accounts);
  const version = useApp((s) => s.settings.metaGraphVersion);
  const keys = useSecrets([SECRET_KEYS.metaAppId, SECRET_KEYS.metaAppSecret]);
  const [choices, setChoices] = useState<PageChoice[] | null>(null);
  const [pasted, setPasted] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const { busy, run } = useAction();
  const meta = accounts.meta;
  const preview = rt?.kind === "preview";

  const adopt = async (c: PageChoice) => {
    await rt!.secrets.set(SECRET_KEYS.metaPageToken, c.pageToken);
    setAccounts({ ...useApp.getState().accounts, meta: c.account });
    setChoices(null);
    toast(c.account.instagramUserId ? `Connected ${c.account.pageName} and @${c.account.instagramUsername}.` : `Connected ${c.account.pageName}. Link your Instagram to this Page to post there.`, "success");
  };

  const connect = () =>
    run("connect", async () => {
      if (keys.dirty) await keys.save();
      const [appId, appSecret] = await Promise.all([rt!.secrets.get(SECRET_KEYS.metaAppId), rt!.secrets.get(SECRET_KEYS.metaAppSecret)]);
      if (!appId || !appSecret) throw new Error("Add your Meta App ID and App Secret first.");
      const pages = await metaLogin({ fetchFn: rt!.fetch, bridge: rt!.oauth, openExternal: rt!.openExternal, appId, appSecret, version });
      if (pages.length === 1) await adopt(pages[0]);
      else setChoices(pages);
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await rt!.secrets.delete(SECRET_KEYS.metaPageToken);
      const { meta: _gone, ...rest } = useApp.getState().accounts;
      setAccounts(rest);
    }, "Disconnected Instagram and Facebook.");

  return (
    <Section id="accounts" title="Instagram and Facebook" intro="Both connect through one Meta app that you own. Your Instagram must be a Creator or Business account linked to your Facebook Page.">
      <PreviewNote />
      {meta ? (
        <div className="well row">
          <span className="chip facebook">{meta.pageName}</span>
          {meta.instagramUsername ? <span className="chip instagram">@{meta.instagramUsername}</span> : <span className="chip warn">No Instagram linked to this Page</span>}
          <span className="spacer" />
          <Btn small variant="ghost" busy={busy === "disconnect"} onClick={() => void disconnect()}>Disconnect</Btn>
        </div>
      ) : null}

      <div className="grid2">
        {keys.field(SECRET_KEYS.metaAppId, "Meta App ID", false)}
        {keys.field(SECRET_KEYS.metaAppSecret, "Meta App Secret")}
      </div>
      <p className="hint">
        In your Meta app's Facebook Login settings, add this as a Valid OAuth Redirect URI: <code>{META_REDIRECT_URI}</code>{" "}
        <button type="button" className="btn ghost sm" onClick={() => rt?.copyText(META_REDIRECT_URI).then(() => toast("Copied.", "success"))}>Copy</button>
      </p>
      <div className="row">
        <Btn variant="primary" busy={busy === "connect"} disabled={preview} onClick={() => void connect()}>{meta ? "Reconnect" : "Connect with Facebook"}</Btn>
        {keys.dirty && <Btn onClick={() => void run("save", keys.save, "Saved to the keychain.")}>Save keys</Btn>}
        <Btn variant="ghost" onClick={() => setShowPaste((v) => !v)} aria-expanded={showPaste}>Use a Page token instead</Btn>
      </div>

      {choices && (
        <div className="col">
          <p className="label">Which Page?</p>
          <div className="list">
            {choices.map((c) => (
              <div key={c.account.pageId} className="list-row">
                <strong style={{ flex: 1 }}>{c.account.pageName}</strong>
                {c.account.instagramUsername && <span className="chip instagram">@{c.account.instagramUsername}</span>}
                <Btn small variant="primary" onClick={() => void run("adopt", () => adopt(c))}>Use this Page</Btn>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPaste && (
        <div className="col">
          <label className="field">
            <span>Page access token (from Meta's Graph API Explorer)</span>
            <input className="input" type="password" autoComplete="off" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          </label>
          <Btn style={{ alignSelf: "flex-start" }} busy={busy === "paste"} disabled={!pasted.trim() || preview}
            onClick={() => void run("paste", async () => { await adopt(await metaFromPageToken(rt!.fetch, version, pasted.trim())); setPasted(""); setShowPaste(false); })}>
            Connect with this token
          </Btn>
        </div>
      )}
    </Section>
  );
}

// ---------- YouTube ----------

function YouTubeSection() {
  const rt = useApp((s) => s.rt);
  const yt = useApp((s) => s.accounts.youtube);
  const keys = useSecrets([SECRET_KEYS.googleClientId, SECRET_KEYS.googleClientSecret]);
  const { busy, run } = useAction();
  const preview = rt?.kind === "preview";

  const connect = () =>
    run("connect", async () => {
      if (keys.dirty) await keys.save();
      const auth = googleAuth(rt!);
      await auth.login(rt!.oauth, rt!.openExternal);
      const channel = await fetchMyChannel(rt!.fetch, auth);
      setAccounts({ ...useApp.getState().accounts, youtube: channel });
    }, "YouTube connected.");

  const disconnect = () =>
    run("disconnect", async () => {
      await googleAuth(rt!).logout();
      const { youtube: _gone, ...rest } = useApp.getState().accounts;
      setAccounts(rest);
    }, "YouTube disconnected.");

  return (
    <Section id="youtube" title="YouTube" intro="Uses a Google Cloud project you own, with the YouTube Data API turned on and a Desktop app login.">
      <PreviewNote />
      {yt && (
        <div className="well row">
          <span className="chip youtube">{yt.channelTitle}</span>
          <span className="spacer" />
          <Btn small variant="ghost" busy={busy === "disconnect"} onClick={() => void disconnect()}>Disconnect</Btn>
        </div>
      )}
      <div className="grid2">
        {keys.field(SECRET_KEYS.googleClientId, "Google Client ID", false)}
        {keys.field(SECRET_KEYS.googleClientSecret, "Google Client Secret")}
      </div>
      <div className="row">
        <Btn variant="primary" busy={busy === "connect"} disabled={preview} onClick={() => void connect()}>{yt ? "Reconnect" : "Connect YouTube"}</Btn>
        {keys.dirty && <Btn onClick={() => void run("save", keys.save, "Saved to the keychain.")}>Save keys</Btn>}
      </div>
      <p className="hint">Until Google audits your project, uploads stay private and you make them public in YouTube Studio. Everything else works normally.</p>
    </Section>
  );
}

// ---------- Supabase ----------

function HandoffSection() {
  const rt = useApp((s) => s.rt);
  const bucket = useApp((s) => s.settings.stagingBucket);
  const keys = useSecrets([SECRET_KEYS.supabaseUrl, SECRET_KEYS.supabaseKey]);
  const { busy, run } = useAction();

  const test = () =>
    run("test", async () => {
      if (keys.dirty) await keys.save();
      const staging = await supabaseStaging(rt!, bucket);
      if (!staging) throw new Error("Add the Supabase project URL and key first.");
      await staging.test();
    }, "The photo hand-off works.");

  return (
    <Section id="handoff" title="Photo hand-off (Instagram photos)" intro="Instagram fetches photos from a link. Conduit parks each photo in your private Supabase bucket for a few minutes, then deletes it. Videos don't need this.">
      <div className="grid2">
        {keys.field(SECRET_KEYS.supabaseUrl, "Supabase project URL", false)}
        {keys.field(SECRET_KEYS.supabaseKey, "Supabase secret key")}
      </div>
      <label className="field" style={{ maxWidth: 320 }}>
        <span>Private bucket name</span>
        <input className="input" value={bucket} onChange={(e) => updateSettings({ stagingBucket: e.target.value.trim() })} />
      </label>
      <div className="row">
        <Btn variant="primary" busy={busy === "test"} disabled={rt?.kind === "preview"} onClick={() => void test()}>Save and test</Btn>
      </div>
    </Section>
  );
}

// ---------- Outbox ----------

function OutboxSection() {
  const outboxPath = useApp((s) => s.settings.outboxPath);
  const { busy, run } = useAction();
  return (
    <Section id="outbox" title="Outbox folder" intro="Export from Premiere, Lightroom or Photoshop into this folder. Each new photo or video becomes a draft in Studio once it has finished saving.">
      <div className="well row">
        <code style={{ flex: 1, overflowWrap: "anywhere" }}>{outboxPath || "No folder chosen"}</code>
        <Btn variant="primary" busy={busy === "pick"} onClick={() => void run("pick", chooseOutbox)}>{outboxPath ? "Change" : "Choose folder"}</Btn>
      </div>
    </Section>
  );
}

// ---------- Inbox ----------

function InboxSection() {
  const s = useApp((st) => st.settings);
  const [newTime, setNewTime] = useState("12:00");
  const times = [...s.inboxCheckTimes].sort();
  const addTime = () => !times.includes(newTime) && updateSettings({ inboxCheckTimes: [...times, newTime].sort() });

  return (
    <Section id="inbox" title="Inbox rhythm" intro="Comments and messages gather at set times instead of arriving all day.">
      <div className="col">
        <p className="label">Check at</p>
        <div className="row" style={{ gap: 8 }}>
          {times.map((t) => (
            <span key={t} className="chip" style={{ paddingRight: 4 }}>
              {formatTime(t)}
              <button type="button" className="btn ghost sm" style={{ minHeight: 24, padding: "0 6px" }} aria-label={`Remove ${formatTime(t)}`}
                onClick={() => updateSettings({ inboxCheckTimes: times.filter((x) => x !== t) })}>×</button>
            </span>
          ))}
          <label className="sr-only" htmlFor="add-time">Add a check time</label>
          <input id="add-time" className="input" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} style={{ width: 140 }} />
          <Btn small icon="plus" onClick={addTime}>Add</Btn>
        </div>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Session length</span>
          <select className="select" value={s.inboxTimeboxMinutes} onChange={(e) => updateSettings({ inboxTimeboxMinutes: Number(e.target.value) })}>
            {[0, 10, 15, 20, 30, 45].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : "No limit"}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Look back for comments</span>
          <select className="select" value={s.commentLookbackDays} onChange={(e) => updateSettings({ commentLookbackDays: Number(e.target.value) })}>
            {[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </div>
    </Section>
  );
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---------- Posting ----------

function PostingSection() {
  const s = useApp((st) => st.settings);
  const setDefault = (p: PlatformId, v: boolean) => updateSettings({ defaultTargets: { ...s.defaultTargets, [p]: v } });
  const setTagSet = (i: number, patch: Partial<Settings["tagSets"][number]>) =>
    updateSettings({ tagSets: s.tagSets.map((t, n) => (n === i ? { ...t, ...patch } : t)) });

  return (
    <Section id="posting" title="Posting">
      <div className="row">
        <span className="label" style={{ marginRight: 8 }}>Season</span>
        <Segmented label="Season" value={s.season} onChange={(season: Season) => updateSettings({ season })}
          options={[{ value: "winter", label: "Winter · snow" }, { value: "summer", label: "Summer · skate" }]} />
      </div>
      <div className="col">
        <p className="label">New drafts post to</p>
        <div className="row" style={{ gap: 18 }}>
          {PLATFORMS.map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={s.defaultTargets[p]} onChange={(e) => setDefault(p, e.target.checked)} />
              {PLATFORM_LABEL[p]}
            </label>
          ))}
        </div>
      </div>
      <label className="check" style={{ fontWeight: 600 }}>
        <input type="checkbox" checked={s.usePlatformScheduling} onChange={(e) => updateSettings({ usePlatformScheduling: e.target.checked })} />
        Let Facebook and YouTube hold scheduled posts themselves (they go out even if this computer is off)
      </label>
      <div className="col">
        <p className="label">Tag sets</p>
        {s.tagSets.map((t, i) => (
          <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
            <input className="input" aria-label="Tag set name" value={t.name} style={{ width: 160 }} onChange={(e) => setTagSet(i, { name: e.target.value })} />
            <input className="input" aria-label={`Tags in ${t.name}`} value={t.tags} onChange={(e) => setTagSet(i, { tags: e.target.value })} />
            <Btn small variant="ghost" aria-label={`Remove ${t.name}`} onClick={() => updateSettings({ tagSets: s.tagSets.filter((_, n) => n !== i) })}>Remove</Btn>
          </div>
        ))}
        <Btn small icon="plus" style={{ alignSelf: "flex-start" }} onClick={() => updateSettings({ tagSets: [...s.tagSets, { name: "New set", tags: "#" }] })}>Add a tag set</Btn>
      </div>
    </Section>
  );
}
