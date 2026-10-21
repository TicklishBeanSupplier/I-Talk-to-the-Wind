import { titleFromCaption, titleFromFileName } from "./captions";
import type { Draft, PlatformId, RemotePost, WorkItem } from "./types";
import { truncate } from "./util";

const remoteKey = (platform: PlatformId, id: string) => `${platform}:${id}`;

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

  for (const p of remote) {
    const k = remoteKey(p.platform, p.remoteId);
    if (used.has(k)) continue;
    items.push({
      key: k,
      title: p.caption.trim() ? truncate(titleFromCaption(p.caption, "Untitled"), 60) : "Untitled",
      at: p.at,
      thumbUrl: p.thumbUrl,
      posts: [p],
    });
  }

  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function draftTitle(d: Draft): string {
  if (d.targets.youtube.enabled && d.targets.youtube.title.trim()) return d.targets.youtube.title.trim();
  const fallback = d.media[0] ? titleFromFileName(d.media[0].name) : "Untitled";
  return truncate(titleFromCaption(d.caption, fallback), 60);
}
