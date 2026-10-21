import type { PlatformAdapter } from "../platforms/types";
import { errorMessage } from "../platforms/types";
import { result } from "./drafts";
import { canUsePlatformScheduler } from "./schedule";
import type { Draft, PlatformId, PublishResult } from "./types";
import { PLATFORMS } from "./types";

export interface PublishPlan {
  /** Send now and publish immediately. */
  now: PlatformId[];
  /** Send now; the platform publishes at the scheduled time. */
  handOff: PlatformId[];
  /** The app publishes these itself when the time comes. */
  later: PlatformId[];
}

const inFlight = (r?: PublishResult) => r?.state === "uploading" || r?.state === "processing";
const finished = (r?: PublishResult) => r?.state === "published" || r?.state === "scheduled";

/** Decide what happens to each platform on a draft right now. */
export function planPublish(
  draft: Draft,
  adapters: Partial<Record<PlatformId, PlatformAdapter>>,
  usePlatformScheduling: boolean,
  now = new Date(),
): PublishPlan {
  const plan: PublishPlan = { now: [], handOff: [], later: [] };
  const at = draft.scheduledFor ? new Date(draft.scheduledFor) : null;
  const due = !at || at.getTime() <= now.getTime();

  for (const p of PLATFORMS) {
    if (!draft.targets[p].enabled) continue;
    const r = draft.results[p];
    if (inFlight(r) || finished(r)) continue;
    if (due) plan.now.push(p);
    else if (usePlatformScheduling && adapters[p]?.capabilities.nativeScheduling && canUsePlatformScheduler(at!, now))
      plan.handOff.push(p);
    else plan.later.push(p);
  }
  return plan;
}

export type ResultUpdate = (platform: PlatformId, update: Partial<PublishResult>) => void;

/**
 * Publish to several platforms in parallel. One platform failing never stops
 * the others; every outcome is reported through `update`.
 */
export async function runPublish(
  draft: Draft,
  platforms: PlatformId[],
  adapters: Partial<Record<PlatformId, PlatformAdapter>>,
  update: ResultUpdate,
  scheduleAt?: Date,
): Promise<void> {
  await Promise.all(
    platforms.map(async (p) => {
      const adapter = adapters[p];
      if (!adapter) {
        update(p, result("failed", { error: "This account isn't connected. Connect it in Settings." }));
        return;
      }
      update(p, result("uploading", { progress: 0, error: undefined }));
      try {
        const final = await adapter.publish(draft, {
          scheduleAt,
          onProgress: (u) => update(p, { ...u, updatedAt: new Date().toISOString() }),
        });
        update(p, final);
      } catch (err) {
        update(p, result("failed", { error: errorMessage(err), progress: undefined }));
      }
    }),
  );
}
