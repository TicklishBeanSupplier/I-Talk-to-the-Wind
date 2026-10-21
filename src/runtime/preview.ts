// Preview runtime: runs in any browser with sample files and no network.
import { snowArt } from "../platforms/mock/art";
import type { DirEntry, MediaInfo, Runtime } from "./types";

interface SampleFile extends DirEntry {
  url: string;
  info: MediaInfo;
}

const OUTBOX = "/Preview/Conduit Outbox";
const minute = 60_000;
const SAMPLE_EPOCH = Date.UTC(2026, 9, 1, 12);

const samples: SampleFile[] = [
  { name: "bluebird_drop.jpg", sizeBytes: 4_200_000, info: { width: 1500, height: 1000 }, url: snowArt(11, 1500, 1000), age: 4 },
  { name: "first_chair_edit_v3.mp4", sizeBytes: 86_000_000, info: { width: 1080, height: 1920, durationSec: 42 }, url: snowArt(5, 540, 960), age: 9 },
  { name: "summit_rime.jpg", sizeBytes: 3_100_000, info: { width: 1080, height: 1350 }, url: snowArt(23, 1080, 1350), age: 30 },
// Fixed times, like real files: the same file must look the same on every load.
].map(({ age, ...f }) => ({ ...f, path: `${OUTBOX}/${f.name}`, modifiedAt: SAMPLE_EPOCH - age * minute }));

const byPath = new Map(samples.map((s) => [s.path, s]));

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function createPreviewRuntime(): Runtime {
  const memory = new Map<string, string>();
  const secrets = new Map<string, string>();
  const prefix = "conduit-preview:";

  return {
    kind: "preview",
    fetch: () => Promise.reject(new Error("Preview mode doesn't use the network.")),

    files: {
      listDir: async (path) => (path === OUTBOX ? samples.map(({ url: _u, info: _i, ...e }) => e) : []),
      fileInfo: async (path) => {
        const f = byPath.get(path);
        if (!f) throw new Error("That sample file doesn't exist.");
        const { url: _u, info: _i, ...entry } = f;
        return entry;
      },
      readBytes: async (path) => new Uint8Array(byPath.get(path)?.sizeBytes ?? 0),
      readChunk: async (_path, _offset, length) => new Uint8Array(length),
      displayUrl: (path) => byPath.get(path)?.url ?? snowArt(path.length * 7),
      probe: async (path) => byPath.get(path)?.info ?? {},
      pickFolder: async () => OUTBOX,
      pickFiles: async () => [samples[2].path],
    },

    secrets: {
      get: async (k) => secrets.get(k) ?? null,
      set: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },

    data: {
      get: async <T>(key: string) => {
        const raw = storage()?.getItem(prefix + key) ?? memory.get(key);
        if (raw === undefined || raw === null) return undefined;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return undefined;
        }
      },
      set: async <T>(key: string, value: T) => {
        const raw = JSON.stringify(value);
        memory.set(key, raw);
        try {
          storage()?.setItem(prefix + key, raw);
        } catch {
          /* storage full or blocked: memory copy still works */
        }
      },
    },

    oauth: {
      listen: async (port) => port,
      waitForRedirect: () => Promise.reject(new Error("Logins aren't available in preview mode.")),
      cancel: async () => undefined,
    },

    openExternal: async (url) => void window.open(url, "_blank", "noopener"),
    copyText: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* clipboard blocked in some frames */
      }
    },
    onResume(cb) {
      const onVisible = () => document.visibilityState === "visible" && cb();
      document.addEventListener("visibilitychange", onVisible);
      const tick = setInterval(cb, 30_000);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        clearInterval(tick);
      };
    },
  };
}

export const PREVIEW_OUTBOX = OUTBOX;
