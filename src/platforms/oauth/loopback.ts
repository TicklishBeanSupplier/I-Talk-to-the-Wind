import type { OAuthBridge } from "../../runtime/types";

export class LoginCancelled extends Error {
  constructor(message = "Login was cancelled.") {
    super(message);
    this.name = "LoginCancelled";
  }
}

/**
 * The desktop login dance: listen on a local port, open the provider's
 * login page in the browser, and wait for it to redirect back with a code.
 */
export async function loopbackLogin(opts: {
  bridge: OAuthBridge;
  openExternal: (url: string) => Promise<void>;
  /** Fixed port (Meta needs a registered redirect) or 0 for any free port. */
  port: number;
  authorizeUrl: (port: number) => string;
  state: string;
  timeoutSec?: number;
}): Promise<{ params: URLSearchParams; port: number }> {
  const port = await opts.bridge.listen(opts.port);
  try {
    await opts.openExternal(opts.authorizeUrl(port));
    const pathAndQuery = await opts.bridge.waitForRedirect(opts.timeoutSec ?? 300);
    const params = new URL(pathAndQuery, "http://127.0.0.1").searchParams;
    const error = params.get("error");
    if (error) {
      const reason = params.get("error_description") ?? params.get("error_reason") ?? error;
      throw new LoginCancelled(error === "access_denied" ? "You declined the login." : `Login failed: ${reason}`);
    }
    if (params.get("state") !== opts.state) throw new Error("Login response didn't match. Please try again.");
    if (!params.get("code")) throw new Error("Login didn't return a code. Please try again.");
    return { params, port };
  } finally {
    await opts.bridge.cancel().catch(() => undefined);
  }
}

export function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE verifier and S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
}
