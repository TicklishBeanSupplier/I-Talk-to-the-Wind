import type { MetaAccount } from "../../core/types";
import { randomToken } from "../../core/util";
import type { FetchFn, OAuthBridge } from "../../runtime/types";
import { loopbackLogin } from "../oauth/loopback";
import { toPlatformError, type GraphErrorBody } from "./graph";

/** Must match a "Valid OAuth Redirect URI" in the Meta app settings. */
export const META_REDIRECT_PORT = 47823;
export const META_REDIRECT_URI = `http://localhost:${META_REDIRECT_PORT}/callback`;

export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_messaging",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "instagram_manage_insights",
];

export interface PageChoice {
  account: MetaAccount;
  pageToken: string;
}

interface AccountsResponse {
  data: {
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username?: string };
  }[];
}

async function getJson<T>(fetchFn: FetchFn, url: string): Promise<T> {
  const res = await fetchFn(url);
  const json = (await res.json().catch(() => ({}))) as T & { error?: unknown };
  if (!res.ok || json.error) throw toPlatformError("facebook", res.status, json as GraphErrorBody);
  return json;
}

/**
 * Log in with Facebook and return every Page you manage, each with a
 * long-lived Page token (these don't expire unless revoked).
 */
export async function metaLogin(opts: {
  fetchFn: FetchFn;
  bridge: OAuthBridge;
  openExternal: (url: string) => Promise<void>;
  appId: string;
  appSecret: string;
  version: string;
}): Promise<PageChoice[]> {
  const { fetchFn, appId, appSecret, version } = opts;
  const state = randomToken();
  const authorize = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  authorize.search = new URLSearchParams({
    client_id: appId,
    redirect_uri: META_REDIRECT_URI,
    state,
    response_type: "code",
    scope: META_SCOPES.join(","),
  }).toString();

  const { params } = await loopbackLogin({
    bridge: opts.bridge,
    openExternal: opts.openExternal,
    port: META_REDIRECT_PORT,
    authorizeUrl: () => authorize.toString(),
    state,
  });

  const graph = `https://graph.facebook.com/${version}`;
  const short = await getJson<{ access_token: string }>(
    fetchFn,
    `${graph}/oauth/access_token?${new URLSearchParams({
      client_id: appId, client_secret: appSecret, redirect_uri: META_REDIRECT_URI, code: params.get("code")!,
    })}`,
  );
  const long = await getJson<{ access_token: string }>(
    fetchFn,
    `${graph}/oauth/access_token?${new URLSearchParams({
      grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token,
    })}`,
  );
  const pages = await getJson<AccountsResponse>(
    fetchFn,
    `${graph}/me/accounts?${new URLSearchParams({
      fields: "id,name,access_token,instagram_business_account{id,username}",
      limit: "100",
      access_token: long.access_token,
    })}`,
  );
  if (!pages.data.length) throw new Error("No Facebook Pages found on this login. Create a Page and link your Instagram to it.");
  return pages.data.map(toChoice);
}

/** Fallback for when the browser login is awkward: paste a Page token. */
export async function metaFromPageToken(fetchFn: FetchFn, version: string, pageToken: string): Promise<PageChoice> {
  const page = await getJson<AccountsResponse["data"][number]>(
    fetchFn,
    `https://graph.facebook.com/${version}/me?${new URLSearchParams({
      fields: "id,name,instagram_business_account{id,username}",
      access_token: pageToken,
    })}`,
  );
  return toChoice({ ...page, access_token: pageToken });
}

function toChoice(p: AccountsResponse["data"][number]): PageChoice {
  return {
    pageToken: p.access_token,
    account: {
      pageId: p.id,
      pageName: p.name,
      instagramUserId: p.instagram_business_account?.id,
      instagramUsername: p.instagram_business_account?.username,
      connectedAt: new Date().toISOString(),
    },
  };
}
