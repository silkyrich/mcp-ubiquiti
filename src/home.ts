/**
 * Link to a "home services" endpoint: a service at home that advertises its
 * own tools (`GET /services`, MCP-shaped) and runs them (`POST /call/<tool>`).
 *
 * The connector knows nothing about what those tools are. It fetches the
 * catalogue when Claude lists tools and forwards calls; a capability added at
 * home appears here on the next tools/list, with nothing to redeploy.
 *
 * The home service sits on localhost behind a Cloudflare Tunnel with Access
 * in front. This client authenticates to Access with a service token and
 * names the signed-in person in `X-Home-Actor` for the home audit log.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const CATALOGUE_TTL_MS = 60_000;

export interface HomeConfig {
  baseUrl: string;      // e.g. https://rules.example.com
  clientId: string;     // Cloudflare Access service token
  clientSecret: string;
  actor: string;        // email of the signed-in connector user
}

export interface HomeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

export class HomeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HomeError";
  }
}

// One catalogue per Worker isolate; a minute is plenty and keeps tools/list quick.
let cached: { at: number; base: string; tools: HomeTool[] } | undefined;

export class HomeClient {
  constructor(private readonly cfg: HomeConfig) {}

  /** The home service's tool list. Failures degrade to "no home tools" rather than breaking tools/list. */
  async tools(): Promise<HomeTool[]> {
    if (cached && cached.base === this.cfg.baseUrl && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.tools;
    try {
      const r = (await this.send("GET", "/services")) as { tools?: HomeTool[] };
      const tools = (r.tools ?? []).filter((t) => /^[a-z][a-z0-9_]*$/.test(t.name));
      cached = { at: Date.now(), base: this.cfg.baseUrl, tools };
      return tools;
    } catch {
      return cached?.tools ?? [];
    }
  }

  async has(name: string): Promise<boolean> {
    return (await this.tools()).some((t) => t.name === name);
  }

  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.send("POST", `/call/${name}`, args);
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
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
        throw new HomeError(`Home ${method} ${path}: ${msg}`.slice(0, 300), res.status);
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }
}
