import type { FetchFn } from "../../runtime/types";
import { randomToken } from "../../core/util";
import { PlatformError } from "../types";

export interface StagedFile {
  url: string;
  remove(): Promise<void>;
}

/**
 * The brief Instagram photo hand-off. Instagram only accepts photos by URL,
 * so we park the file in a private Supabase bucket behind a short-lived
 * signed link, then delete it once Instagram has it.
 */
export class SupabaseStaging {
  private readonly base: string;

  constructor(
    private readonly fetchFn: FetchFn,
    projectUrl: string,
    private readonly key: string,
    private readonly bucket: string,
  ) {
    this.base = `${projectUrl.replace(/\/+$/, "")}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }

  async put(bytes: Uint8Array, contentType: string, expiresInSec = 900): Promise<StagedFile> {
    const ext = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1] ?? "bin";
    const path = `handoff/${Date.now()}-${randomToken(8)}.${ext}`;
    const objectUrl = `${this.base}/object/${this.bucket}/${path}`;

    const up = await this.fetchFn(objectUrl, {
      method: "POST",
      headers: this.headers({ "Content-Type": contentType, "x-upsert": "true" }),
      body: bytes as unknown as BodyInit,
    });
    if (!up.ok) throw new PlatformError(`Photo hand-off failed: ${await describe(up)}`, "instagram");

    const remove = async () => {
      // Best effort: a leftover file expires from the signed link anyway.
      await this.fetchFn(`${this.base}/object/${this.bucket}`, {
        method: "DELETE",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: [path] }),
      }).catch(() => undefined);
    };

    const signed = await this.fetchFn(`${this.base}/object/sign/${this.bucket}/${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: expiresInSec }),
    });
    if (!signed.ok) {
      await remove();
      throw new PlatformError(`Photo hand-off couldn't create a link: ${await describe(signed)}`, "instagram");
    }
    const { signedURL } = (await signed.json()) as { signedURL: string };
    return { url: `${this.base}${signedURL.startsWith("/") ? "" : "/"}${signedURL}`, remove };
  }

  /** Settings → "Test": upload a tiny file, sign it, delete it. */
  async test(): Promise<void> {
    const f = await this.put(new TextEncoder().encode("ok"), "text/plain", 60);
    await f.remove();
  }
}

async function describe(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: string; error?: string };
    return j.message ?? j.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
