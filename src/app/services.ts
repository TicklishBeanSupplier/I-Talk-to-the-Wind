// Builds live platform connections from the saved accounts and keys.
import type { Accounts, MediaFile, PlatformId, Settings } from "../core/types";
import { FacebookAdapter } from "../platforms/meta/facebook";
import { GraphClient } from "../platforms/meta/graph";
import { InstagramAdapter, type MetaDeps } from "../platforms/meta/instagram";
import { mockAdapters } from "../platforms/mock/mock";
import { SupabaseStaging } from "../platforms/staging/supabase";
import type { MediaReader, PlatformAdapter } from "../platforms/types";
import { PlatformError } from "../platforms/types";
import { GoogleAuth } from "../platforms/youtube/auth";
import { YouTubeAdapter } from "../platforms/youtube/youtube";
import { toJpeg } from "../runtime/imaging";
import type { Runtime } from "../runtime/types";
import { SECRET_KEYS } from "../runtime/types";

export type Adapters = Partial<Record<PlatformId, PlatformAdapter>>;

export function mediaReader(rt: Runtime): MediaReader {
  return {
    bytes: (m: MediaFile) => rt.files.readBytes(m.path),
    chunk: (m, offset, length) => rt.files.readChunk(m.path, offset, length),
    jpeg: async (m) => toJpeg(await rt.files.readBytes(m.path), m.mime),
  };
}

/** One GoogleAuth per runtime, so the in-memory access token is shared. */
const googleAuths = new WeakMap<Runtime, GoogleAuth>();
export function googleAuth(rt: Runtime): GoogleAuth {
  let a = googleAuths.get(rt);
  if (!a) googleAuths.set(rt, (a = new GoogleAuth(rt.fetch, rt.secrets)));
  return a;
}

export async function supabaseStaging(rt: Runtime, bucket: string): Promise<SupabaseStaging | null> {
  const [url, key] = await Promise.all([rt.secrets.get(SECRET_KEYS.supabaseUrl), rt.secrets.get(SECRET_KEYS.supabaseKey)]);
  return url && key ? new SupabaseStaging(rt.fetch, url, key, bucket) : null;
}

export function buildAdapters(rt: Runtime, accounts: Accounts, settings: Settings): Adapters {
  if (rt.kind === "preview") return mockAdapters();

  const adapters: Adapters = {};
  const media = mediaReader(rt);

  if (accounts.meta) {
    // Read the Page token from the keychain once; adapters are rebuilt on reconnect.
    let cached: Promise<string> | undefined;
    const token = () =>
      (cached ??= rt.secrets
        .get(SECRET_KEYS.metaPageToken)
        .then((t) => {
          if (!t) throw new PlatformError("Your Meta login is missing. Reconnect in Settings.", "facebook", undefined, true);
          return t;
        })
        .catch((err) => {
          cached = undefined; // don't remember a failure
          throw err;
        }));
    const deps = (platform: "instagram" | "facebook"): MetaDeps => ({
      fetchFn: rt.fetch,
      graph: new GraphClient(rt.fetch, settings.metaGraphVersion, token, platform),
      account: accounts.meta!,
      media,
      staging: () => supabaseStaging(rt, settings.stagingBucket),
    });
    adapters.facebook = new FacebookAdapter(deps("facebook"));
    if (accounts.meta.instagramUserId) adapters.instagram = new InstagramAdapter(deps("instagram"));
  }

  if (accounts.youtube) adapters.youtube = new YouTubeAdapter(rt.fetch, googleAuth(rt), accounts.youtube, media);

  return adapters;
}
