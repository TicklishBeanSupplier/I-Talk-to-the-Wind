import { randomToken } from "../../core/util";
import type { FetchFn, OAuthBridge, SecretStore } from "../../runtime/types";
import { SECRET_KEYS } from "../../runtime/types";
import { loopbackLogin, pkcePair } from "../oauth/loopback";
import { PlatformError } from "../types";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Google login for an installed desktop app (loopback + PKCE), plus
 * access-token refresh. The refresh token lives in the credential store;
 * access tokens live only in memory.
 */
export class GoogleAuth {
  private access?: { token: string; expiresAt: number };
  private refreshing?: Promise<string>;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly secrets: SecretStore,
  ) {}

  private async client(): Promise<{ id: string; secret: string }> {
    const [id, secret] = await Promise.all([
      this.secrets.get(SECRET_KEYS.googleClientId),
      this.secrets.get(SECRET_KEYS.googleClientSecret),
    ]);
    if (!id || !secret) throw new PlatformError("Add your Google client ID and secret in Settings first.", "youtube");
    return { id, secret };
  }

  async login(bridge: OAuthBridge, openExternal: (url: string) => Promise<void>): Promise<void> {
    const { id, secret } = await this.client();
    const { verifier, challenge } = await pkcePair();
    const state = randomToken();
    const redirectFor = (port: number) => `http://127.0.0.1:${port}/callback`;
    const authorizeUrl = (port: number) => {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectFor(port),
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      return u.toString();
    };

    // Port 0: Google accepts any loopback port for desktop clients.
    const { params, port } = await loopbackLogin({ bridge, openExternal, port: 0, authorizeUrl, state });
    const tokens = await this.token({
      grant_type: "authorization_code",
      code: params.get("code")!,
      code_verifier: verifier,
      redirect_uri: redirectFor(port),
      client_id: id,
      client_secret: secret,
    });
    if (!tokens.refresh_token) throw new PlatformError("Google didn't return a long-term login. Please try again.", "youtube");
    await this.secrets.set(SECRET_KEYS.googleRefreshToken, tokens.refresh_token);
    this.remember(tokens);
  }

  async logout(): Promise<void> {
    this.access = undefined;
    await this.secrets.delete(SECRET_KEYS.googleRefreshToken);
  }

  /** A valid access token, refreshing it if it's about to expire. */
  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token;
    // Several requests may ask at once; only refresh once.
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const refreshToken = await this.secrets.get(SECRET_KEYS.googleRefreshToken);
    if (!refreshToken) throw new PlatformError("YouTube isn't connected. Connect it in Settings.", "youtube", undefined, true);
    const { id, secret } = await this.client();
    const tokens = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: id, client_secret: secret });
    return this.remember(tokens);
  }

  private remember(t: TokenResponse): string {
    this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  private async token(body: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.error) {
      const expired = json.error === "invalid_grant";
      throw new PlatformError(
        expired ? "Your YouTube login has expired. Reconnect in Settings." : `Google login failed: ${json.error_description ?? json.error ?? res.status}`,
        "youtube",
        json,
        expired,
      );
    }
    return json;
  }
}
