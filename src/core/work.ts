import { titleFromCaption, titleFromFileName } from "./captions";
import type { Draft, PlatformId, RemotePost, WorkItem } from "./types";
import { truncate } from "./util";

const remoteKey = (platform: PlatformId, id: string) => `${platform}:${id}`;
const SAME_POST_WINDOW_MS = 3 * 3_600_000;
const normalizeTitle = (caption: string) => titleFromCaption(caption, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Build the Work list: posts published from this app are grouped across
 * platforms; posts made elsewhere appear on their own.
 */
export function groupWork(drafts: Draft[], remote: RemotePost[]): WorkItem[] {
  const byKey = new Map(remote.map((p) => [remoteKey(p.platform, p.remoteId), p]));
  const used = new Set<string>();
  const items: WorkItem[] = [];

  for (const d of drafts) {
    const posts: RemotePost[] = [];
    for (const [platform, r] of Object.entries(d.results) as [PlatformId, Draft["results"][PlatformId]][]) {
      if (!r?.remoteId || r.state !== "published") continue;
      const k = remoteKey(platform, r.remoteId);
      const found = byKey.get(k);
      used.add(k);
      posts.push(
        found ?? {
          platform,
          remoteId: r.remoteId,
          permalink: r.permalink,
          caption: d.caption,
          at: d.publishedAt ?? r.updatedAt,
          kind: d.media[0]?.kind === "video" ? "video" : d.media.length > 1 ? "carousel" : "image",
          stats: {},
        },
      );
    }
    if (!posts.length) continue;
    items.push({
      key: `draft:${d.id}`,
      draftId: d.id,
      title: draftTitle(d),
      at: d.publishedAt ?? posts[0].at,
      thumbUrl: posts.find((p) => p.thumbUrl)?.thumbUrl,
      posts,
    });
  }

  // Posts made elsewhere: the same piece shared to several platforms within a
  // few hours under the same title is grouped as one.
  const outside = remote.filter((p) => !used.has(remoteKey(p.platform, p.remoteId))).sort((a, b) => a.at.localeCompare(b.at));
  const groups: RemotePost[][] = [];
  for (const p of outside) {
    const title = normalizeTitle(p.caption);
    const t = new Date(p.at).getTime();
    const group = title
      ? groups.find((g) =>
          !g.some((x) => x.platform === p.platform) &&
          normalizeTitle(g[0].caption) === title &&
          Math.abs(new Date(g[0].at).getTime() - t) <= SAME_POST_WINDOW_MS)
      : undefined;
    if (group) group.push(p);
    else groups.push([p]);
  }
  for (const g of groups) {
    const first = g[0];
    items.push({
      key: g.map((p) => remoteKey(p.platform, p.remoteId)).join("+"),
      title: first.caption.trim() ? truncate(titleFromCaption(first.caption, "Untitled"), 60) : "Untitled",
      at: first.at,
      thumbUrl: g.find((p) => p.thumbUrl)?.thumbUrl,
      posts: g,
    });
  }

  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function draftTitle(d: Draft): string {
  if (d.targets.youtube.enabled && d.targets.youtube.title.trim()) return d.targets.youtube.title.trim();
  const fallback = d.media[0] ? titleFromFileName(d.media[0].name) : "Untitled";
  return truncate(titleFromCaption(d.caption, fallback), 60);
}
