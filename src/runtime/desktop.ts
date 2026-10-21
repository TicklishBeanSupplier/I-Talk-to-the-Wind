// The real runtime inside the desktop app (Windows or macOS), backed by
// the Rust side in src-tauri.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { load, type Store } from "@tauri-apps/plugin-store";
import { probeImage, probeVideo } from "./imaging";
import type { DirEntry, Runtime } from "./types";

const MEDIA_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "tif", "tiff", "mp4", "mov", "m4v", "webm"];

const bytes = (buf: ArrayBuffer | number[]) => (buf instanceof ArrayBuffer ? new Uint8Array(buf) : Uint8Array.from(buf));

export async function createDesktopRuntime(): Promise<Runtime> {
  const store: Store = await load("conduit-data.json", { autoSave: false, defaults: {} });
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void store.save(), 300);
  };

  return {
    kind: "desktop",
    fetch: (input, init) => tauriFetch(input, init),

    files: {
      listDir: (path) => invoke<DirEntry[]>("list_dir", { path }),
      fileInfo: (path) => invoke<DirEntry>("file_info", { path }),
      readBytes: async (path) => bytes(await invoke<ArrayBuffer>("read_file", { path })),
      readChunk: async (path, offset, length) => bytes(await invoke<ArrayBuffer>("read_chunk", { path, offset, length })),
      displayUrl: (path) => convertFileSrc(path),
      probe: (path, kind) => (kind === "video" ? probeVideo(convertFileSrc(path)) : probeImage(convertFileSrc(path))),
      pickFolder: async () => {
        const r = await open({ directory: true, multiple: false, title: "Choose your Outbox folder" });
        return typeof r === "string" ? r : null;
      },
      pickFiles: async () => {
        const r = await open({ multiple: true, title: "Add photos or videos", filters: [{ name: "Photos and videos", extensions: MEDIA_EXTENSIONS }] });
        return Array.isArray(r) ? r : r ? [r] : [];
      },
    },

    secrets: {
      get: (key) => invoke<string | null>("secret_get", { key }),
      set: (key, value) => invoke<void>("secret_set", { key, value }),
      delete: (key) => invoke<void>("secret_delete", { key }),
    },

    data: {
      get: <T>(key: string) => store.get<T>(key),
      set: async <T>(key: string, value: T) => {
        await store.set(key, value);
        scheduleSave();
      },
    },

    oauth: {
      listen: (port) => invoke<number>("oauth_listen", { port }),
      waitForRedirect: (timeoutSec) => invoke<string>("oauth_wait", { timeoutSec }),
      cancel: () => invoke<void>("oauth_cancel"),
    },

    openExternal: (url) => openUrl(url),
    copyText: (text) => navigator.clipboard.writeText(text),

    onResume(cb) {
      const onVisible = () => document.visibilityState === "visible" && cb();
      document.addEventListener("visibilitychange", onVisible);
      // The Rust side also pings every 30 s, which keeps the scheduler
      // running while the window is hidden.
      const unlisten = Promise.all([listen("conduit://resume", cb), listen("conduit://tick", cb)]);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        void unlisten.then((fns) => fns.forEach((f) => f()));
      };
    },
  };
}
