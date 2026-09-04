/**
 * UniFi cloud client.
 *
 * All access goes through Ubiquiti's own cloud API (api.ui.com) using a
 * Site Manager API key — no local proxy, tunnel, or on-prem agent required.
 *
 * Two surfaces are used:
 *   1. Site Manager API   — https://api.ui.com/v1/{hosts,sites}
 *      High-level fleet data: device/client counts, ISP info, WAN uptime.
 *   2. Connector proxy    — https://api.ui.com/v1/connector/consoles/{hostId}/proxy/network/...
 *      Relays to the console's Network application API, giving the full
 *      per-client / per-device / stats surface remotely.
 *
 * The proxy forwards to the console's `http://127.0.0.1/proxy/[path]`, so the
 * legacy Network paths (`/api/s/<site>/stat/...`) work through it unchanged.
 */

export interface UnifiConfig {
  apiKey: string;   // Site Manager API key (secret)
  hostId: string;   // Console host id, e.g. "6C63...:524037498"
  site?: string;    // Network site name, defaults to "default"
}

const API_BASE = "https://api.ui.com/v1";
const REQUEST_TIMEOUT_MS = 25_000; // Ubiquiti cloud proxy caps at ~25s

export class UnifiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "UnifiError";
  }
}

export class UnifiClient {
  private readonly site: string;
  private tz?: string;

  constructor(private readonly cfg: UnifiConfig) {
    this.site = cfg.site ?? "default";
  }

  private headers(): HeadersInit {
    return { "X-API-KEY": this.cfg.apiKey, Accept: "application/json" };
  }

  private async get(url: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: this.headers(), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new UnifiError(
          `UniFi API ${res.status} for ${url}`,
          res.status,
          text.slice(0, 500),
        );
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Path on the console's Network app, relayed through the cloud connector. */
  private proxyUrl(networkPath: string): string {
    const p = networkPath.startsWith("/") ? networkPath : `/${networkPath}`;
    return `${API_BASE}/connector/consoles/${this.cfg.hostId}/proxy/network${p}`;
  }

  private siteApi(path: string): string {
    return this.proxyUrl(`/api/s/${this.site}${path}`);
  }

  // ── Site Manager (fleet) surface ──────────────────────────────────────

  /** All consoles owned by this account. */
  async hosts(): Promise<any[]> {
    const r = await this.get(`${API_BASE}/hosts`);
    return r?.data ?? [];
  }

  /** Site-level rollup: device/client counts, ISP, WAN uptime, tx-retry %. */
  async sites(): Promise<any[]> {
    const r = await this.get(`${API_BASE}/sites`);
    return r?.data ?? [];
  }

  // ── Network application surface (via connector proxy) ─────────────────

  /** Active clients currently connected. */
  async clients(): Promise<any[]> {
    const r = await this.get(this.siteApi("/stat/sta"));
    return r?.data ?? [];
  }

  /** All adopted devices (gateways, switches, APs) with live state. */
  async devices(): Promise<any[]> {
    const r = await this.get(this.siteApi("/stat/device"));
    return r?.data ?? [];
  }

  /** Configured WLANs (SSIDs). Read-only here. */
  async wlans(): Promise<any[]> {
    const r = await this.get(this.siteApi("/rest/wlanconf"));
    return r?.data ?? [];
  }

  /** POST a JSON body to the Network app. The legacy stats API needs this. */
  private async postJson(url: string, body: unknown): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new UnifiError(`UniFi API ${res.status} for ${url}`, res.status, text.slice(0, 500));
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Per-client byte counters bucketed over time.
   *
   * Retention is roughly: 5minutes ~1 day, hourly ~1 week, daily ~30 days.
   * NOTE the units trap — these take MILLISECONDS, while /stat/session takes
   * SECONDS. Passing ms to session returns 200 with zero rows, silently.
   */
  async userReport(
    interval: "5minutes" | "hourly" | "daily",
    startMs: number,
    endMs: number,
    macs?: string[],
  ): Promise<any[]> {
    const body: Record<string, unknown> = {
      attrs: ["rx_bytes", "tx_bytes", "time"],
      start: startMs,
      end: endMs,
    };
    if (macs?.length) body.macs = macs.map((m) => m.toLowerCase());
    const r = await this.postJson(this.siteApi(`/stat/report/${interval}.user`), body);
    return r?.data ?? [];
  }

  /**
   * Association sessions: when each client joined, how long it stayed, and
   * how much it moved between APs.
   *
   * NOTE the units trap: this takes SECONDS, while /stat/report takes
   * MILLISECONDS. Passing ms here returns 200 with zero rows, silently —
   * a valid-looking empty answer rather than an error.
   */
  async sessions(startSec: number, endSec: number): Promise<any[]> {
    const r = await this.postJson(this.siteApi("/stat/session"), {
      type: "all",
      start: startSec,
      end: endSec,
    });
    return r?.data ?? [];
  }

  /** The console's timezone, so history can be reported in local time. */
  async siteTimezone(): Promise<string> {
    if (this.tz) return this.tz;
    try {
      const sites = await this.sites();
      this.tz = sites[0]?.meta?.timezone || "UTC";
    } catch {
      this.tz = "UTC";
    }
    return this.tz!;
  }

  /** All clients the console knows about, including currently-offline ones. */
  async knownClients(): Promise<any[]> {
    const r = await this.get(this.siteApi("/list/user"));
    return r?.data ?? [];
  }

  /**
   * Set a client's display name. This is the ONLY write in this connector:
   * it changes a label in the client list, never network configuration.
   */
  async renameClient(id: string, name: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.siteApi(`/upd/user/${id}`), {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ name }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new UnifiError(`UniFi rename ${res.status}`, res.status, text.slice(0, 500));
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Configured networks / VLANs. */
  async networks(): Promise<any[]> {
    const r = await this.get(this.siteApi("/rest/networkconf"));
    return r?.data ?? [];
  }
}
