/**
 * mcp-ubiquiti — remote MCP connector for UniFi.
 *
 * Wiring:
 *   OAuthProvider  guards the /mcp route (Claude must present a valid token).
 *   defaultHandler owns the browser-facing OAuth pages:
 *      /authorize  → start login: stash Claude's OAuth request, redirect to Google
 *      /callback   → Google returns: verify email allowlist, complete the grant
 *   apiHandler     → the MCP JSON-RPC endpoint, reached only after auth.
 *
 * Only ALLOWED_EMAIL (a single Google account) can complete the flow, so a
 * token is never minted for anyone else — access is bound to that identity.
 */

import OAuthProvider, { type OAuthHelpers, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { handleMcp } from "./mcp";
import type { UnifiConfig } from "./unifi";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers; // injected by the provider
  // Secrets (wrangler secret put ...)
  UNIFI_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // Vars (wrangler.jsonc)
  UNIFI_HOST_ID: string;
  UNIFI_SITE: string;
  ALLOWED_EMAIL: string;
}

// Props carried on the token and exposed to the API handler via ctx.props.
interface Props {
  email: string;
  [key: string]: unknown;
}

// A fetch handler with a *required* fetch method (what the provider expects).
type Handler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
};

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const LOGIN_TTL_SECONDS = 600;

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset=utf-8><title>mcp-ubiquiti</title>${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Browser-facing OAuth + landing pages. */
const defaultHandler: Handler = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/callback`;

    // ── Step 1: Claude sends the user here to authorize ─────────────────
    if (url.pathname === "/authorize") {
      let oauthReq: AuthRequest;
      try {
        oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return html("<h1>Invalid authorization request</h1>", 400);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
      if (!client) return html("<h1>Unknown OAuth client</h1>", 400);

      // Stash Claude's request across the Google round-trip.
      const loginState = crypto.randomUUID();
      await env.OAUTH_KV.put(`login:${loginState}`, JSON.stringify(oauthReq), {
        expirationTtl: LOGIN_TTL_SECONDS,
      });

      const g = new URL(GOOGLE_AUTH);
      g.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      g.searchParams.set("redirect_uri", redirectUri);
      g.searchParams.set("response_type", "code");
      g.searchParams.set("scope", "openid email profile");
      g.searchParams.set("access_type", "online");
      g.searchParams.set("prompt", "select_account");
      g.searchParams.set("state", loginState);
      return Response.redirect(g.toString(), 302);
    }

    // ── Step 2: Google redirects back here with a code ──────────────────
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const loginState = url.searchParams.get("state");
      if (!code || !loginState) return html("<h1>Missing code/state</h1>", 400);

      const stashed = await env.OAUTH_KV.get(`login:${loginState}`);
      if (!stashed) return html("<h1>Login expired — please try again</h1>", 400);
      await env.OAUTH_KV.delete(`login:${loginState}`);
      const oauthReq = JSON.parse(stashed) as AuthRequest;

      // Exchange the code for a Google access token.
      const tokenRes = await fetch(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) return html("<h1>Google token exchange failed</h1>", 502);
      const token = (await tokenRes.json()) as { access_token?: string };
      if (!token.access_token) return html("<h1>No access token from Google</h1>", 502);

      const infoRes = await fetch(GOOGLE_USERINFO, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (!infoRes.ok) return html("<h1>Could not read Google profile</h1>", 502);
      const info = (await infoRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
      };

      // ── The allowlist gate: only ALLOWED_EMAIL may proceed ────────────
      if (!info.email || info.email_verified !== true || info.email !== env.ALLOWED_EMAIL) {
        return html(
          `<h1>Access denied</h1><p>This connector is restricted to a single account.</p>`,
          403,
        );
      }

      const props: Props = { email: info.email };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: info.email,
        metadata: { email: info.email },
        scope: oauthReq.scope,
        props,
      });
      return Response.redirect(redirectTo, 302);
    }

    // ── Landing page ────────────────────────────────────────────────────
    if (url.pathname === "/") {
      return html(
        `<h1>mcp-ubiquiti</h1><p>Remote MCP connector for UniFi. Add <code>${url.origin}/mcp</code> as a custom connector in Claude.</p>`,
      );
    }

    return html("<h1>Not found</h1>", 404);
  },
};

/** The MCP endpoint — only reached with a valid token. */
const apiHandler: Handler = {
  async fetch(request, env, ctx): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    // Defence in depth: the token should only exist for ALLOWED_EMAIL.
    if (!props || props.email !== env.ALLOWED_EMAIL) {
      return new Response("Forbidden", { status: 403 });
    }
    const cfg: UnifiConfig = {
      apiKey: env.UNIFI_API_KEY,
      hostId: env.UNIFI_HOST_ID,
      site: env.UNIFI_SITE || "default",
    };
    return handleMcp(request, cfg);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp:read"],
});
