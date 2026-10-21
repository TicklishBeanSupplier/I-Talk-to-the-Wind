import type { FetchFn } from "../../runtime/types";
import type { PlatformId } from "../../core/types";
import { PlatformError } from "../types";

export type Params = Record<string, string | number | boolean | undefined>;

export interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string; fbtrace_id?: string };
}

/**
 * A thin client for Meta's Graph API. Instagram and Facebook both go
 * through here, using the Page access token.
 */
export class GraphClient {
  readonly base: string;

  constructor(
    private readonly fetchFn: FetchFn,
    readonly version: string,
    private readonly token: () => Promise<string>,
    private readonly platform: PlatformId,
    host = "https://graph.facebook.com",
  ) {
    this.base = `${host}/${version}`;
  }

  async accessToken(): Promise<string> {
    return this.token();
  }

  url(path: string, params: Params = {}): string {
    const u = new URL(path.startsWith("http") ? path : `${this.base}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async get<T>(path: string, params: Params = {}): Promise<T> {
    const token = await this.token();
    return this.handle<T>(await this.fetchFn(this.url(path, { ...params, access_token: token })));
  }

  /** POST as form fields, which every Graph endpoint accepts. */
  async post<T>(path: string, params: Params = {}): Promise<T> {
    const token = await this.token();
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, access_token: token }))
      if (v !== undefined) body.set(k, String(v));
    return this.handle<T>(
      await this.fetchFn(this.url(path), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  }

  async postJson<T>(path: string, json: unknown): Promise<T> {
    const token = await this.token();
    return this.handle<T>(
      await this.fetchFn(this.url(path, { access_token: token }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      }),
    );
  }

  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    const token = await this.token();
    form.set("access_token", token);
    return this.handle<T>(await this.fetchFn(this.url(path), { method: "POST", body: form }));
  }

  /** Follow `paging.next` links, up to `maxPages`. */
  async getAll<T>(path: string, params: Params, maxPages = 3): Promise<T[]> {
    const out: T[] = [];
    let page = await this.get<{ data: T[]; paging?: { next?: string } }>(path, params);
    out.push(...page.data);
    for (let i = 1; i < maxPages && page.paging?.next; i++) {
      page = await this.handle(await this.fetchFn(page.paging.next));
      out.push(...page.data);
    }
    return out;
  }

  async handle<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok || (json as GraphErrorBody).error) {
      throw toPlatformError(this.platform, res.status, json as GraphErrorBody);
    }
    return json as T;
  }
}

export function toPlatformError(platform: PlatformId, status: number, body: GraphErrorBody): PlatformError {
  const e = body.error ?? {};
  const code = e.code;
  const sub = e.error_subcode;
  const raw = e.error_user_msg || e.message || `Request failed (${status}).`;

  // Order matters: the specific subcodes come before the broad codes they share.
  if (sub === 2018278 || sub === 2534022)
    return new PlatformError("The 24-hour reply window for this conversation has closed.", platform, body);
  if (code === 190 || code === 102)
    return new PlatformError("Your Meta login has expired or was revoked. Reconnect in Settings.", platform, body, true);
  if (code === 4 || code === 17 || code === 32 || code === 613)
    return new PlatformError("Meta is limiting requests right now. Try again in a few minutes.", platform, body);
  if (code === 9007 || sub === 2207027)
    return new PlatformError("Instagram is still processing the media. Try again shortly.", platform, body);
  if (code === 9004 || sub === 2207052)
    return new PlatformError("Instagram couldn't fetch the photo. Check the Supabase settings.", platform, body);
  if (code === 10 || (code !== undefined && code >= 200 && code < 300))
    return new PlatformError(`Meta says the app is missing a permission. ${e.message ?? ""}`.trim(), platform, body, true);
  return new PlatformError(raw, platform, body);
}

/** Meta's resumable upload host: send the whole file in one request. */
export async function ruploadBytes(
  fetchFn: FetchFn,
  url: string,
  token: string,
  bytes: Uint8Array,
  platform: PlatformId,
): Promise<void> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(bytes.byteLength),
      "Content-Type": "application/octet-stream",
    },
    body: bytes as unknown as BodyInit,
  });
  const text = await res.text();
  let json: { success?: boolean; debug_info?: { message?: string } } & GraphErrorBody = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || json.error || json.success === false) {
    if (json.error) throw toPlatformError(platform, res.status, json);
    throw new PlatformError(json.debug_info?.message ?? `Upload failed (${res.status}).`, platform, text);
  }
}
