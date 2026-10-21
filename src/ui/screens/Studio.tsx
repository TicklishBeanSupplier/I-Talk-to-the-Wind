import { useMemo, useState } from "react";
import { captionFor, countHashtags, hasOverride } from "../../core/captions";
import { draftTitle } from "../../core/work";
import { planPublish } from "../../core/publish";
import { canUsePlatformScheduler, dayAndTime, relativeTime } from "../../core/schedule";
import type { Draft, DraftTargets, MediaFile, PlatformId, PublishResult } from "../../core/types";
import { PLATFORM_LABEL, PLATFORMS } from "../../core/types";
import { formatBytes, formatDuration } from "../../core/util";
import { LIMITS, validateDraft, type Issue } from "../../core/validate";
import {
  addMediaToDraft, deleteDraft, draftFromPicker, navigate, publishDraft, retryPlatform, toast, unschedule, updateDraft, useApp,
} from "../../app/store";
import { Btn, Icon, PlatformChip, Progress, Segmented, Thumb, useAction, useNow } from "../kit";
import { Layout } from "../Layout";

const WEEK = 7 * 86_400_000;
const LOCKED_STATES = new Set<PublishResult["state"]>(["waiting", "uploading", "processing", "scheduled", "published"]);
const isLocked = (d: Draft) => PLATFORMS.some((p) => d.targets[p].enabled && d.results[p] && LOCKED_STATES.has(d.results[p]!.state));

export function StudioScreen({ draftId }: { draftId?: string }) {
  const drafts = useApp((s) => s.drafts);
  const selected = drafts.find((d) => d.id === draftId) ?? drafts.find((d) => d.status === "draft" || d.status === "failed") ?? drafts[0];
  return (
    <Layout label="Studio" rail={<StudioRail drafts={drafts} selectedId={selected?.id} />}>
      {selected ? <Composer key={selected.id} draft={selected} /> : <NoDrafts />}
    </Layout>
  );
}

// ---------- Rail ----------

function StudioRail({ drafts, selectedId }: { drafts: Draft[]; selectedId?: string }) {
  const outboxPath = useApp((s) => s.settings.outboxPath);
  const season = useApp((s) => s.settings.season);
  const { busy, run } = useAction();
  const now = useNow(60_000);

  const groups = useMemo(() => {
    const open = drafts.filter((d) => d.status === "draft" || d.status === "failed" || d.status === "partial");
    const sending = drafts.filter((d) => d.status === "publishing");
    const queued = drafts.filter((d) => d.status === "scheduled");
    const posted = drafts.filter((d) => d.status === "published" && now.getTime() - new Date(d.publishedAt ?? d.updatedAt).getTime() < WEEK);
    return { open, sending, queued, posted };
  }, [drafts, now]);

  const folder = outboxPath.split(/[\\/]/).filter(Boolean).pop();
  return (
    <>
      <div className="rail-pad">
        <h1 className="mega sm">OUTBOX</h1>
        <p className="rail-sub">{folder ? `Watching “${folder}” · ${season === "winter" ? "Winter" : "Summer"} season` : "No Outbox folder yet. Choose one in Settings."}</p>
        <Btn variant="on-panel-soft" icon="plus" busy={busy === "add"} onClick={() => run("add", draftFromPicker)}>Add files</Btn>
      </div>
      <div className="rail-scroll" style={{ marginTop: 10 }}>
        <RailGroup title="Drafts" drafts={groups.open} selectedId={selectedId} describe={(d) => (d.status === "draft" ? mediaLine(d.media[0]) : statusLine(d))} />
        <RailGroup title="Posting now" drafts={groups.sending} selectedId={selectedId} describe={(d) => `Uploading to ${platformShort(d)}…`} />
        <RailGroup title="Scheduled" drafts={groups.queued} selectedId={selectedId} describe={(d) => (d.scheduledFor ? `${dayAndTime(d.scheduledFor)} · ${platformShort(d)}` : platformShort(d))} />
        {groups.posted.length > 0 && (
          <>
            <p className="rail-label">Posted this week · {groups.posted.length}</p>
            <div className="row rail-pad" style={{ gap: 8 }}>
              {groups.posted.slice(0, 10).map((d) => (
                <button key={d.id} type="button" onClick={() => navigate({ screen: "studio", draftId: d.id })} style={{ border: 0, padding: 0, background: "none", borderRadius: 10 }} aria-label={`Open ${draftTitle(d)}`}>
                  <MediaThumb media={d.media[0]} size={48} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function RailGroup({ title, drafts, selectedId, describe }: { title: string; drafts: Draft[]; selectedId?: string; describe: (d: Draft) => string }) {
  if (!drafts.length) return null;
  return (
    <>
      <p className="rail-label">{title} · {drafts.length}</p>
      {drafts.map((d) => (
        <button key={d.id} type="button" className="rail-item" aria-current={d.id === selectedId ? "true" : undefined} onClick={() => navigate({ screen: "studio", draftId: d.id })}>
          <MediaThumb media={d.media[0]} size={52} />
          <span className="stack">
            <span className="title">{d.media.length > 1 ? `${draftTitle(d)} (+${d.media.length - 1})` : draftTitle(d)}</span>
            <span className="meta">{describe(d)}</span>
          </span>
        </button>
      ))}
    </>
  );
}

const platformShort = (d: Draft) => PLATFORMS.filter((p) => d.targets[p].enabled).map((p) => ({ instagram: "IG", facebook: "FB", youtube: "YT" })[p]).join(", ");

function mediaLine(m?: MediaFile): string {
  if (!m) return "No media";
  const shape = m.width && m.height ? ` · ${m.width}×${m.height}` : "";
  return m.kind === "video" ? `Video${m.durationSec ? ` · ${formatDuration(m.durationSec)}` : ""}${shape}` : `Photo${shape}`;
}

function statusLine(d: Draft): string {
  if (d.status === "failed") return "Didn't go out. Open to retry.";
  if (d.status === "partial") return "Some platforms failed. Open to retry.";
  return "";
}

/** A still for a photo, or the first frame of a video. */
export function MediaThumb({ media, size }: { media?: MediaFile; size: number }) {
  const rt = useApp((s) => s.rt);
  if (!media || !rt) return <Thumb alt="" size={size} />;
  const url = rt.files.displayUrl(media.path);
  if (media.kind === "video" && !url.startsWith("data:"))
    return <video className="thumb" src={`${url}#t=0.5`} muted playsInline preload="metadata" style={{ width: size, height: size }} aria-hidden="true" />;
  return <Thumb src={url} alt="" size={size} />;
}

function NoDrafts() {
  const outboxPath = useApp((s) => s.settings.outboxPath);
  return (
    <div className="empty" style={{ minHeight: "80%" }}>
      <h2 className="h1">Nothing waiting to post</h2>
      <p style={{ maxWidth: 460 }}>
        {outboxPath
          ? "Export from Premiere, Lightroom or Photoshop into your Outbox folder and it will show up here as a draft."
          : "Choose an Outbox folder in Settings. Anything you export there becomes a draft here."}
      </p>
      {!outboxPath && <Btn variant="primary" onClick={() => navigate({ screen: "settings" })}>Open Settings</Btn>}
    </div>
  );
}

// ---------- Composer ----------

function Composer({ draft }: { draft: Draft }) {
  const adapters = useApp((s) => s.adapters);
  const now = useNow(30_000);
  const issues = useMemo(() => validateDraft(draft, now), [draft, now]);
  const locked = isLocked(draft);
  const { busy, run } = useAction();

  const set = (patch: Partial<Draft>) => updateDraft(draft.id, patch);
  const setTarget = <P extends PlatformId>(p: P, patch: Partial<DraftTargets[P]>) =>
    updateDraft(draft.id, (d) => ({ targets: { ...d.targets, [p]: { ...d.targets[p], ...patch } } }));

  return (
    <div className="stage-inner">
      <header className="row" style={{ marginBottom: 22 }}>
        <div className="col" style={{ gap: 4, flex: 1, minWidth: 260 }}>
          <h2 className="h1">{draftTitle(draft)}</h2>
          <p className="muted small" style={{ margin: 0 }}>Added {relativeTime(draft.createdAt, now)} · {draft.media.map((m) => m.name).join(", ")}</p>
        </div>
        {!locked && <Btn variant="ghost" icon="trash" onClick={() => deleteDraft(draft.id)}>Delete draft</Btn>}
      </header>

      <div className="stage-split">
        <div className="main" style={{ flex: "1 1 360px", maxWidth: 520 }}>
          <MediaPanel draft={draft} locked={locked} onRemove={(id) => set({ media: draft.media.filter((m) => m.id !== id) })} />
          <IssueList issues={issues} />
        </div>

        <div className="main" style={{ flex: "1 1 420px" }}>
          {locked ? (
            <ResultsPanel draft={draft} />
          ) : (
            <>
              <section className="col" aria-labelledby="post-to">
                <p className="label" id="post-to">Post to</p>
                <TargetRow draft={draft} platform="instagram" connected={!!adapters.instagram} onToggle={(v) => setTarget("instagram", { enabled: v })}>
                  <Segmented label="Instagram format" tone="instagram" value={draft.targets.instagram.format} onChange={(format) => setTarget("instagram", { format })}
                    options={[
                      { value: "post", label: "Post", disabled: draft.media.length !== 1 || draft.media[0]?.kind !== "image" },
                      { value: "reel", label: "Reel", disabled: draft.media.length !== 1 || draft.media[0]?.kind !== "video" },
                      { value: "story", label: "Story", disabled: draft.media.length !== 1 },
                      { value: "carousel", label: "Carousel", disabled: draft.media.length < 2 },
                    ]} />
                </TargetRow>
                <TargetRow draft={draft} platform="facebook" connected={!!adapters.facebook} onToggle={(v) => setTarget("facebook", { enabled: v })}>
                  <Segmented label="Facebook format" tone="facebook" value={draft.targets.facebook.format} onChange={(format) => setTarget("facebook", { format })}
                    options={[
                      { value: "post", label: "Post", disabled: draft.media.some((m) => m.kind === "video") },
                      { value: "reel", label: "Reel", disabled: draft.media.length !== 1 || draft.media[0]?.kind !== "video" },
                      { value: "video", label: "Video", disabled: draft.media.length !== 1 || draft.media[0]?.kind !== "video" },
                    ]} />
                </TargetRow>
                <TargetRow draft={draft} platform="youtube" connected={!!adapters.youtube} onToggle={(v) => setTarget("youtube", { enabled: v })}
                  unavailable={draft.media.length !== 1 || draft.media[0]?.kind !== "video" ? "Video only" : undefined}>
                  <Segmented label="YouTube visibility" tone="youtube" value={draft.targets.youtube.privacy} onChange={(privacy) => setTarget("youtube", { privacy })}
                    options={[{ value: "public", label: "Public" }, { value: "unlisted", label: "Unlisted" }, { value: "private", label: "Private" }]} />
                </TargetRow>
              </section>

              {draft.targets.youtube.enabled && (
                <section className="col">
                  <label className="field">
                    <span>YouTube title ({draft.targets.youtube.title.length}/{LIMITS.youtube.titleChars})</span>
                    <input className="input" value={draft.targets.youtube.title} maxLength={LIMITS.youtube.titleChars + 20} onChange={(e) => setTarget("youtube", { title: e.target.value })} />
                  </label>
                  <label className="check small" style={{ fontWeight: 600 }}>
                    <input type="checkbox" checked={draft.targets.youtube.madeForKids} onChange={(e) => setTarget("youtube", { madeForKids: e.target.checked })} />
                    Made for kids (YouTube requires you to say)
                  </label>
                </section>
              )}

              <CaptionEditor draft={draft} />
              <WhenPicker draft={draft} now={now} />

              <div className="row" style={{ marginTop: 4 }}>
                <Btn variant="primary" busy={busy === "publish"} disabled={issues.some((i) => i.level === "error")}
                  onClick={() => run("publish", () => publishDraft(draft.id))}>
                  {draft.scheduledFor ? `Schedule for ${dayAndTime(draft.scheduledFor, now)}` : "Publish now"}
                </Btn>
                <span className="hint">Changes save automatically.</span>
              </div>
              <ScheduleExplainer draft={draft} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TargetRow({ draft, platform, connected, onToggle, unavailable, children }: {
  draft: Draft; platform: PlatformId; connected: boolean; onToggle: (v: boolean) => void; unavailable?: string; children: React.ReactNode;
}) {
  const enabled = draft.targets[platform].enabled;
  const blocked = !!unavailable || !connected;
  // Never trap a platform switched on: you can always turn it off.
  const disabled = blocked && !enabled;
  const id = `t-${platform}`;
  return (
    <div className="row" style={{ background: disabled ? "var(--well)" : "var(--card)", borderRadius: 16, padding: "10px 14px", boxShadow: enabled ? `0 0 0 2px var(--${platform === "instagram" ? "ig" : platform === "facebook" ? "fb" : "yt"})` : "none" }}>
      <label className="check" htmlFor={id} style={{ minWidth: 120, color: disabled ? "var(--faint)" : undefined }}>
        <input id={id} type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
        {PLATFORM_LABEL[platform]}
      </label>
      <span className="spacer" />
      {unavailable ? <span className="small muted">{unavailable}</span>
        : !connected ? <button type="button" className="btn ghost sm" onClick={() => navigate({ screen: "settings" })}>Connect in Settings</button>
        : enabled ? children : null}
      {blocked && enabled && <span className="small" style={{ color: "var(--danger)", flexBasis: "100%" }}>Switch this off to post.</span>}
    </div>
  );
}

// ---------- Media ----------

function MediaPanel({ draft, locked, onRemove }: { draft: Draft; locked: boolean; onRemove: (id: string) => void }) {
  const rt = useApp((s) => s.rt);
  const [index, setIndex] = useState(0);
  const { busy, run } = useAction();
  const m = draft.media[Math.min(index, draft.media.length - 1)];
  if (!rt) return null;
  const url = m ? rt.files.displayUrl(m.path) : undefined;
  const ratio = m?.width && m?.height ? `${m.width} / ${m.height}` : "4 / 5";

  return (
    <section className="col" aria-label="Media">
      <div style={{ background: "var(--well)", borderRadius: 20, overflow: "hidden", display: "grid", placeItems: "center", maxHeight: 560 }}>
        {!m ? <p className="muted" style={{ padding: 40 }}>No media. Add a file.</p>
          : m.kind === "video" && url && !url.startsWith("data:") ? (
            <video src={url} controls preload="metadata" style={{ width: "100%", maxHeight: 560, aspectRatio: ratio, background: "#000" }} aria-label={m.name} />
          ) : (
            <img src={url} alt={m.name} style={{ width: "100%", maxHeight: 560, aspectRatio: ratio, objectFit: "contain" }} />
          )}
      </div>
      {m && <p className="small muted" style={{ margin: 0 }}>{mediaLine(m)} · {formatBytes(m.sizeBytes)}</p>}
      {(draft.media.length > 1 || !locked) && (
        <div className="row" style={{ gap: 8 }}>
          {draft.media.map((x, i) => (
            <div key={x.id} style={{ position: "relative" }}>
              <button type="button" onClick={() => setIndex(i)} aria-label={`Show ${x.name}`} aria-pressed={i === index} style={{ border: 0, padding: 0, background: "none", borderRadius: 10, boxShadow: i === index ? "0 0 0 2px var(--panel)" : "none" }}>
                <MediaThumb media={x} size={56} />
              </button>
              {!locked && draft.media.length > 1 && (
                <button type="button" className="btn soft sm" aria-label={`Remove ${x.name}`} onClick={() => { onRemove(x.id); setIndex(0); }}
                  style={{ position: "absolute", top: -8, right: -8, minHeight: 24, width: 24, padding: 0 }}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
          {!locked && <Btn small icon="plus" busy={busy === "more"} onClick={() => run("more", () => addMediaToDraft(draft.id))}>Add more</Btn>}
        </div>
      )}
    </section>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <div className="well small" style={{ color: "var(--go-ink)" }}><b>✓</b> Ready to go.</div>;
  return (
    <div className="well col" style={{ gap: 6 }} role="list" aria-label="Checks">
      {issues.map((i, n) => (
        <div key={n} className={`issue ${i.level}`} role="listitem">
          <b aria-hidden="true">{i.level === "error" ? "!" : i.level === "warning" ? "△" : "i"}</b>
          <span>{i.platform !== "all" && <strong>{PLATFORM_LABEL[i.platform]}: </strong>}{i.message}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- Caption ----------

type CaptionTab = "all" | PlatformId;

function CaptionEditor({ draft }: { draft: Draft }) {
  const tagSets = useApp((s) => s.settings.tagSets);
  const [tab, setTab] = useState<CaptionTab>("all");
  const enabled = PLATFORMS.filter((p) => draft.targets[p].enabled);
  const activeTab: CaptionTab = tab !== "all" && !enabled.includes(tab) ? "all" : tab;

  const overrideKey = (p: PlatformId) => (p === "youtube" ? "descriptionOverride" : "captionOverride");
  const value = activeTab === "all" ? draft.caption : captionFor(draft, activeTab);
  const setValue = (text: string) =>
    updateDraft(draft.id, (d) =>
      activeTab === "all" ? { caption: text } : { targets: { ...d.targets, [activeTab]: { ...d.targets[activeTab], [overrideKey(activeTab)]: text } } },
    );
  const resetOverride = (p: PlatformId) =>
    updateDraft(draft.id, (d) => ({ targets: { ...d.targets, [p]: { ...d.targets[p], [overrideKey(p)]: undefined } } }));

  const limit = activeTab === "youtube" ? LIMITS.youtube.descriptionBytes : activeTab === "facebook" ? LIMITS.facebook.captionChars : LIMITS.instagram.captionChars;
  const addTags = (tags: string) => setValue(value.includes(tags) ? value : `${value.trimEnd()}${value.trim() ? "\n\n" : ""}${tags}`);

  return (
    <section className="col">
      <div className="row" style={{ gap: 6 }}>
        <label className="label" htmlFor="caption" style={{ marginRight: "auto" }}>{activeTab === "youtube" ? "YouTube description" : "Caption"}</label>
        <Segmented label="Caption for" value={activeTab} onChange={setTab}
          options={[{ value: "all", label: "Shared" }, ...enabled.map((p) => ({ value: p as CaptionTab, label: hasOverride(draft, p) ? `${PLATFORM_LABEL[p]} •` : PLATFORM_LABEL[p] }))]} />
      </div>
      <textarea id="caption" className="textarea big" rows={6} value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="Say something about it. Hashtags at the end work well." />
      <div className="row small" style={{ gap: 8 }}>
        <span className="muted">Tag sets</span>
        {tagSets.map((t) => (
          <button key={t.name} type="button" className="chip" style={{ border: 0, cursor: "pointer" }} onClick={() => addTags(t.tags)} title={t.tags}>+ {t.name}</button>
        ))}
        <span className="spacer" />
        {activeTab !== "all" && hasOverride(draft, activeTab) && <button type="button" className="btn ghost sm" onClick={() => resetOverride(activeTab)}>Use shared caption</button>}
        <span className="muted">
          {(activeTab === "all" || activeTab === "instagram") && `${countHashtags(value)}/${LIMITS.instagram.hashtags} hashtags · `}
          {value.length.toLocaleString()}/{limit.toLocaleString()}
        </span>
      </div>
      {activeTab === "all" && enabled.some((p) => hasOverride(draft, p)) && (
        <p className="hint">Platforms marked • have their own version and won't use this text.</p>
      )}
    </section>
  );
}

// ---------- Scheduling ----------

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function tomorrowAt(h: number, m: number, now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
}

function WhenPicker({ draft, now }: { draft: Draft; now: Date }) {
  const later = !!draft.scheduledFor;
  const setAt = (d: Date | null) => updateDraft(draft.id, { scheduledFor: d ? d.toISOString() : null });
  const presets = [
    { label: "Tomorrow 7:30 am", at: tomorrowAt(7, 30, now) },
    { label: "Tomorrow 6:00 pm", at: tomorrowAt(18, 0, now) },
  ];
  return (
    <section className="col">
      <p className="label">When</p>
      <div className="row">
        <Segmented label="When to post" value={later ? "later" : "now"} onChange={(v) => setAt(v === "now" ? null : presets[0].at)}
          options={[{ value: "now", label: "Now" }, { value: "later", label: "Later" }]} />
        {later && presets.map((p) => (
          <button key={p.label} type="button" className="chip" style={{ border: 0, cursor: "pointer" }} onClick={() => setAt(p.at)}>{p.label}</button>
        ))}
      </div>
      {later && (
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Date and time</span>
          <input className="input" type="datetime-local" min={toLocalInput(now)} value={toLocalInput(new Date(draft.scheduledFor!))}
            onChange={(e) => e.target.value && setAt(new Date(e.target.value))} />
        </label>
      )}
    </section>
  );
}

function ScheduleExplainer({ draft }: { draft: Draft }) {
  const adapters = useApp((s) => s.adapters);
  const usePlatform = useApp((s) => s.settings.usePlatformScheduling);
  if (!draft.scheduledFor) return null;
  const at = new Date(draft.scheduledFor);
  if (!canUsePlatformScheduler(at) && !draft.targets.instagram.enabled) {
    return <p className="hint">This is soon, so Conduit will send it itself at that time. Keep Conduit running (it can sit in the tray).</p>;
  }
  const plan = planPublish(draft, adapters, usePlatform);
  const names = (ps: PlatformId[]) => ps.map((p) => PLATFORM_LABEL[p]).join(" and ");
  return (
    <p className="hint">
      {plan.handOff.length > 0 && `${names(plan.handOff)} get${plan.handOff.length === 1 ? "s" : ""} it now and post${plan.handOff.length === 1 ? "s" : ""} it on time by ${plan.handOff.length === 1 ? "itself" : "themselves"}. `}
      {plan.later.length > 0 && `${names(plan.later)} will be sent from this computer at that time, so keep Conduit running (it can sit in the tray).`}
    </p>
  );
}

// ---------- Results ----------

const STATE_TEXT: Record<PublishResult["state"], string> = {
  waiting: "Waiting for its time",
  uploading: "Uploading",
  processing: "Processing",
  scheduled: "Scheduled on the platform",
  published: "Posted",
  failed: "Didn't go out",
};

function ResultsPanel({ draft }: { draft: Draft }) {
  const rt = useApp((s) => s.rt);
  const { busy, run } = useAction();
  const enabled = PLATFORMS.filter((p) => draft.targets[p].enabled);
  const hasWaiting = enabled.some((p) => draft.results[p]?.state === "waiting");

  return (
    <section className="col" aria-label="Where it went">
      <p className="label">{draft.status === "published" ? "Posted" : draft.scheduledFor ? `Scheduled · ${dayAndTime(draft.scheduledFor)}` : "Status"}</p>
      <div className="list">
        {enabled.map((p) => {
          const r = draft.results[p];
          const state = r?.state ?? "waiting";
          return (
            <div key={p} className="list-row" style={{ alignItems: "flex-start" }}>
              <PlatformChip platform={p} />
              <div className="col" style={{ flex: 1, gap: 6, minWidth: 200 }}>
                <strong style={{ color: state === "failed" ? "var(--danger)" : undefined }}>{STATE_TEXT[state]}</strong>
                {(state === "uploading" || state === "processing") && <Progress value={r?.progress ?? 0} label={`${PLATFORM_LABEL[p]} progress`} />}
                {r?.error && <span className="small" style={{ color: "var(--danger)" }}>{r.error}</span>}
                {r?.note && <span className="small muted">{r.note}</span>}
              </div>
              {state === "failed" && <Btn small variant="primary" icon="refresh" busy={busy === p} onClick={() => run(p, () => retryPlatform(draft.id, p))}>Retry</Btn>}
              {r?.permalink && (state === "published" || state === "scheduled") && (
                <Btn small icon="copy" onClick={() => rt?.copyText(r.permalink!).then(() => toast("Link copied.", "success"))}>Copy link</Btn>
              )}
            </div>
          );
        })}
      </div>
      {draft.caption && <p className="small muted" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{draft.caption}</p>}
      <div className="row">
        {hasWaiting && <Btn onClick={() => unschedule(draft.id)}>Unschedule to edit</Btn>}
        {draft.status === "published" && <Btn onClick={() => navigate({ screen: "work", key: `draft:${draft.id}` })}>See it in Work</Btn>}
      </div>
    </section>
  );
}
