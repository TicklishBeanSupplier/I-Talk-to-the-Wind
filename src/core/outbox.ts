import type { DirEntry } from "../runtime/types";
import { isIgnorableFile, mediaTypeFromName } from "./util";

/** What the watcher remembers between scans. */
export interface OutboxMemory {
  /** Files already turned into drafts: path -> modified time. */
  seen: Record<string, number>;
  /** Candidates waiting to stop growing: path -> size at last scan. */
  pending: Record<string, number>;
}

export const emptyOutbox = (): OutboxMemory => ({ seen: {}, pending: {} });

/**
 * Compare a folder listing with memory. A new file is only "ready" once its
 * size is the same on two scans in a row, so half-written exports from
 * Premiere or Lightroom are never picked up.
 */
export function scanOutbox(entries: DirEntry[], memory: OutboxMemory): { ready: DirEntry[]; memory: OutboxMemory } {
  const pending: Record<string, number> = {};
  const ready: DirEntry[] = [];

  for (const e of entries) {
    if (isIgnorableFile(e.name) || !mediaTypeFromName(e.name)) continue;
    if (memory.seen[e.path] === e.modifiedAt) continue; // already handled, unchanged
    if (e.sizeBytes > 0 && memory.pending[e.path] === e.sizeBytes) ready.push(e);
    else pending[e.path] = e.sizeBytes;
  }

  const seen = { ...memory.seen };
  for (const e of ready) seen[e.path] = e.modifiedAt;
  // Forget files that were deleted from the folder.
  const present = new Set(entries.map((e) => e.path));
  for (const path of Object.keys(seen)) if (!present.has(path)) delete seen[path];

  return { ready, memory: { seen, pending } };
}

/** On first setup, treat what's already in the folder as old news. */
export function adoptExisting(entries: DirEntry[]): OutboxMemory {
  const seen: Record<string, number> = {};
  for (const e of entries) seen[e.path] = e.modifiedAt;
  return { seen, pending: {} };
}
