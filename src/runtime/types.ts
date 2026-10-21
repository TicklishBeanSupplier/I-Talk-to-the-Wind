// The app reaches the outside world (files, secrets, network, browser) only
// through these interfaces. The desktop app (Windows or macOS) and the
// browser preview each provide one implementation.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface DirEntry {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface MediaInfo {
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface FileAccess {
  /** Files directly inside a folder (not recursive, no hidden files). */
  listDir(path: string): Promise<DirEntry[]>;
  /** Size and modified time of one file. */
  fileInfo(path: string): Promise<DirEntry>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Part of a file, for uploading large videos without loading them whole. */
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** A URL an <img>/<video> can display. */
  displayUrl(path: string): string;
  /** Pixel size and length of a photo or video. */
  probe(path: string, kind: "image" | "video"): Promise<MediaInfo>;
  /** Ask the user to pick a folder. Null if they cancel. */
  pickFolder(): Promise<string | null>;
  /** Ask the user to pick photos or videos. */
  pickFiles(): Promise<string[]>;
}

/** Secrets live in the OS credential store (Keychain / Credential Manager). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Plain app data (drafts, inbox, settings), saved as JSON. */
export interface DataStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface OAuthBridge {
  /** Start listening on the loopback address for the login redirect. Port 0 = any free port. Returns the port. */
  listen(port: number): Promise<number>;
  /** Wait for the browser to come back; resolves with the redirect's path and query. */
  waitForRedirect(timeoutSec: number): Promise<string>;
  /** Stop listening early (e.g. the user cancelled). */
  cancel(): Promise<void>;
}

export interface Runtime {
  kind: "desktop" | "preview";
  fetch: FetchFn;
  files: FileAccess;
  secrets: SecretStore;
  data: DataStore;
  oauth: OAuthBridge;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Called by the shell when the machine wakes or the window is shown again. */
  onResume(cb: () => void): () => void;
}

/** Credential-store entry names. */
export const SECRET_KEYS = {
  metaAppId: "meta.appId",
  metaAppSecret: "meta.appSecret",
  metaPageToken: "meta.pageToken",
  googleClientId: "google.clientId",
  googleClientSecret: "google.clientSecret",
  googleRefreshToken: "google.refreshToken",
  supabaseUrl: "supabase.url",
  supabaseKey: "supabase.key",
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];
