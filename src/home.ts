/**
 * Client for the home policy engine (archie-control `server/api.py`).
 *
 * The engine runs on a box inside the house, bound to localhost, published
 * through a Cloudflare Tunnel with Access in front. The Worker authenticates
 * to Access with a service token, and names the person who asked in
 * `X-Home-Actor` so the engine's audit log records a human, not a token.
 *
 * Optional: when the three HOME_* secrets are absent the archie_* tools
 * simply report that the home link is not configured.
 */

const REQUEST_TIMEOUT_MS = 20_000;

export interface HomeConfig {
  baseUrl: string;        // e.g. https://rules.example.com
  clientId: string;       // Access service token
  clientSecret: string;
  actor: string;          // email of the signed-in connector user
}

export class HomeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HomeError";
  }
}

export class HomeClient {
  constructor(private readonly cfg: HomeConfig) {}

  status() { return this.send("GET", "/api/status"); }
  usage() { return this.send("GET", "/api/usage"); }
  allow(body: { target: string; minutes?: number; until?: string; reason?: string }) {
    return this.send("POST", "/api/allow", body);
  }
  revoke(target: string) { return this.send("POST", "/api/revoke", { target }); }
  flush(target: string) { return this.send("POST", "/api/flush", { target }); }

  private async send(method: string, path: string, body?: unknown): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.cfg.baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: {
          "CF-Access-Client-Id": this.cfg.clientId,
          "CF-Access-Client-Secret": this.cfg.clientSecret,
          "X-Home-Actor": this.cfg.actor,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      // Access answers a login page (HTML) when the service token is rejected.
      const isJson = (res.headers.get("content-type") || "").includes("json");
      if (!res.ok || !isJson) {
        const msg = isJson ? (JSON.parse(text).error ?? text) : `Access refused the request (${res.status})`;
        throw new HomeError(`Home engine ${method} ${path}: ${msg}`.slice(0, 300), res.status);
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }
}
