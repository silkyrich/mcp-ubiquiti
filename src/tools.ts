/**
 * MCP tool definitions for the UniFi connector.
 *
 * All tools are READ-ONLY in this first cut — they observe the network
 * (who's on it, device health, performance, ISP) but never mutate config.
 * Write tools (SSID/firewall/etc.) are intentionally deferred until the
 * read surface is trusted in production.
 */

import { UnifiClient } from "./unifi";

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: UnifiClient, args: Record<string, any>) => Promise<unknown>;
}

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

/** UniFi's radio codes, as bands people recognise. */
const BAND: Record<string, string> = { ng: "2.4GHz", na: "5GHz", "6e": "6GHz" };

/**
 * The PHY the client actually negotiated, as a Wi-Fi generation.
 *
 * This is the honest answer to "is this thing modern?" — better than guessing
 * from the MAC vendor, because it is what the AP and client agreed over the
 * air. Note it is independent of the band: a Wi-Fi 6 client parked on a
 * 2.4GHz-only SSID still reports `ax`. The converse does not hold — 802.11ac
 * does not exist on 2.4GHz, so a Wi-Fi 5 client there reports `ng`.
 */
const PHY: Record<string, string> = {
  b: "802.11b (legacy)",
  g: "802.11g (legacy)",
  ng: "Wi-Fi 4 (802.11n)",
  na: "Wi-Fi 4 (802.11n)",
  ac: "Wi-Fi 5 (802.11ac)",
  ax: "Wi-Fi 6 (802.11ax)",
  be: "Wi-Fi 7 (802.11be)",
};

/** Bytes → human string. */
function human(bytes: number): string {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${u[i]}`;
}

export const TOOLS: Tool[] = [
  {
    name: "network_overview",
    description:
      "High-level health of the network: device and client counts, ISP, WAN uptime, and tx-retry. Best first call to understand the site.",
    inputSchema: EMPTY_SCHEMA,
    handler: async (client) => {
      const sites = await client.sites();
      return sites.map((s) => {
        const st = s.statistics ?? {};
        const c = st.counts ?? {};
        const wan = st.wans ?? {};
        return {
          site: s.meta?.desc ?? s.meta?.name,
          timezone: s.meta?.timezone,
          gateway: st.gateway?.shortname,
          isp: st.ispInfo?.name,
          wanUptimePct: st.percentages?.wanUptime,
          txRetryPct: st.percentages?.txRetry != null
            ? Number(st.percentages.txRetry.toFixed(2))
            : undefined,
          devices: { total: c.totalDevice, offline: c.offlineDevice },
          clients: {
            wifi: c.wifiClient,
            wired: c.wiredClient,
            guest: c.guestClient,
          },
          wans: Object.fromEntries(
            Object.entries(wan).map(([k, v]: [string, any]) => [
              k,
              { externalIp: v.externalIp, uptimePct: v.wanUptime, up: v.portUp },
            ]),
          ),
        };
      });
    },
  },

  {
    name: "list_clients",
    description:
      "List clients currently connected, with IP, MAC, VLAN, SSID (or wired), live throughput, and — for wifi clients — which access point they're on, how strongly it hears them (signal in dBm), and the PHY they negotiated (Wi-Fi generation, channel width, spatial streams, link rate). Because the AP is named after its location, the signal gives a rough idea of where a device is; the PHY shows whether a device is a modern radio or a legacy one. Optionally filter by a search string matched against name/hostname/IP/MAC.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive filter over name/hostname/ip/mac." },
        limit: { type: "number", description: "Max clients to return (default 50)." },
        wifi_only: { type: "boolean", description: "Return only wireless clients." },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const search = (args.search ?? "").toLowerCase();
      const limit = Number.isFinite(args.limit) ? Math.max(1, args.limit) : 50;
      const [clients, devices] = await Promise.all([client.clients(), client.devices()]);

      // APs are named for where they are ("U7 Pro - Kitchen"), so resolving
      // ap_mac to that name is what turns a signal reading into a location.
      const apName = new Map<string, string>(
        devices.filter((d) => d.mac).map((d) => [String(d.mac).toLowerCase(), d.name || d.model]),
      );

      const shaped = clients
        .filter((c) => !args.wifi_only || !c.is_wired)
        .map((c) => {
          const base = {
            name: c.name || c.hostname || "(unknown)",
            ip: c.ip,
            mac: c.mac,
            vlan: c.vlan ?? null,
            connection: c.is_wired ? "wired" : (c.essid ?? "wifi"),
            rx: c.rx_bytes ?? 0,
            tx: c.tx_bytes ?? 0,
            total_h: human((c.rx_bytes ?? 0) + (c.tx_bytes ?? 0)),
            uptime_s: c.uptime,
          };
          // Wired clients have no radio; wifi clients occasionally report none
          // either (mesh/just-roamed), so every RF field stays optional.
          if (c.is_wired || c.signal == null) return base;
          return {
            ...base,
            ap: apName.get(String(c.ap_mac).toLowerCase()) ?? c.ap_mac ?? null,
            ap_mac: c.ap_mac ?? null,
            signal_dbm: c.signal,           // negative; closer to 0 is stronger
            noise_dbm: c.noise ?? null,
            snr_db: c.noise != null ? c.signal - c.noise : null,
            band: BAND[c.radio] ?? c.radio ?? null,
            channel: c.channel ?? null,
            satisfaction: c.satisfaction ?? null,
            // What the client negotiated, not what it is capable of.
            phy: PHY[c.radio_proto] ?? c.radio_proto ?? null,
            channel_width_mhz: c.channel_width ?? null,
            spatial_streams: c.nss ?? null,
            tx_rate_mbps: c.tx_rate != null ? Math.round(c.tx_rate / 1000) : null,
            rx_rate_mbps: c.rx_rate != null ? Math.round(c.rx_rate / 1000) : null,
          };
        })
        .filter((c) =>
          !search ||
          [c.name, c.ip, c.mac].some((f) => String(f).toLowerCase().includes(search)),
        )
        .sort((a, b) => b.rx + b.tx - (a.rx + a.tx));
      return { count: shaped.length, clients: shaped.slice(0, limit) };
    },
  },

  {
    name: "list_devices",
    description:
      "List adopted UniFi devices (gateway, switches, access points) with online state, model, firmware, and connected-client count.",
    inputSchema: EMPTY_SCHEMA,
    handler: async (client) => {
      const devices = await client.devices();
      return devices.map((d) => ({
        name: d.name || d.model,
        model: d.model,
        type: d.type,
        online: d.state === 1,
        clients: d.num_sta,
        firmware: d.version,
        ip: d.ip,
        mac: d.mac,
        uptime_s: d.uptime,
      }));
    },
  },

  {
    name: "list_wifi",
    description:
      "List configured WiFi networks (SSIDs), their security mode, and which VLAN/network each maps to. Passphrases are NOT returned.",
    inputSchema: EMPTY_SCHEMA,
    handler: async (client) => {
      const [wlans, networks] = await Promise.all([client.wlans(), client.networks()]);
      const netName = new Map(networks.map((n) => [n._id, n.name]));
      return wlans.map((w) => ({
        ssid: w.name,
        enabled: w.enabled,
        security: w.security ?? w.wpa_mode,
        band: w.wlan_band,
        hidden: w.hide_ssid,
        network: netName.get(w.networkconf_id) ?? w.networkconf_id,
        ppsk_enabled: !!w.private_preshared_keys_enabled,
      }));
    },
  },

  {
    name: "list_networks",
    description: "List configured networks/VLANs with their VLAN IDs.",
    inputSchema: EMPTY_SCHEMA,
    handler: async (client) => {
      const networks = await client.networks();
      return networks.map((n) => ({
        name: n.name,
        vlan: n.vlan ?? null,
        purpose: n.purpose,
        enabled: n.enabled,
        subnet: n.ip_subnet,
      }));
    },
  },

  {
    name: "client_history",
    description:
      "How much traffic a client used over time, for answering questions like 'when was the iPad streaming this morning?'. Returns a time series when one device matches, or a ranked list of the busiest devices when several do. Retention on the console limits how far back each resolution goes: 5-minute buckets last about a day, hourly about a week, daily about a month.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Filter to a device by name, hostname or MAC. Omit to rank all clients.",
        },
        hours: { type: "number", description: "How far back to look. Default 24, max 720 (30 days)." },
        bucket: {
          type: "string",
          enum: ["5minutes", "hourly", "daily"],
          description: "Resolution. Chosen automatically from the window if omitted.",
        },
        limit: { type: "number", description: "Max devices in the ranked list (default 15)." },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const hours = Math.min(720, Math.max(1, Number(args.hours) || 24));
      // 5-minute data is trimmed after ~a day and hourly after ~a week, so
      // pick the finest resolution the window can actually be served at.
      const bucket: "5minutes" | "hourly" | "daily" =
        args.bucket ?? (hours <= 24 ? "5minutes" : hours <= 168 ? "hourly" : "daily");
      const endMs = Date.now();
      const startMs = endMs - hours * 3600 * 1000;

      // /list/user covers clients that have since gone offline; /stat/sta
      // would only name the ones connected right now.
      const known = await client.knownClients();
      const label = (mac: string) => {
        const u = known.find((k) => String(k.mac).toLowerCase() === mac.toLowerCase());
        return u?.name || u?.hostname || mac;
      };

      let macs: string[] | undefined;
      if (args.search) {
        const q = String(args.search).toLowerCase();
        // Dedupe: /list/user can hold more than one record per MAC, which
        // would otherwise push a single-device query down the ranked path.
        macs = [
          ...new Set(
            known
              .filter((u) =>
                [u.name, u.hostname, u.mac].some((f) =>
                  String(f ?? "").toLowerCase().includes(q),
                ),
              )
              .map((u) => String(u.mac).toLowerCase()),
          ),
        ];
        if (!macs.length) throw new Error(`No known client matching "${args.search}".`);
      }

      const [rows, tz] = await Promise.all([
        client.userReport(bucket, startMs, endMs, macs),
        client.siteTimezone(),
      ]);
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      });
      // Direction is NOT uniform across link types, which is easy to miss.
      // For wireless clients the counters are AP-relative, so tx is the
      // client's download. For WIRED clients they arrive swapped: an Xbox
      // showed 8.4 GB of "upload" in one hour and an LG TV 11.3 GB, neither
      // of which is a thing those devices do — both are plainly downloads.
      // So normalise on is_wired and report true down/up throughout.
      const wired = new Set(
        known.filter((u) => u.is_wired).map((u) => String(u.mac).toLowerCase()),
      );
      const dirOf = (macRaw: string, r: any) => {
        const w = wired.has(String(macRaw).toLowerCase());
        return { down: (w ? r.rx_bytes : r.tx_bytes) ?? 0, up: (w ? r.tx_bytes : r.rx_bytes) ?? 0 };
      };
      const mb = (b: number) => Math.round(((b ?? 0) / 1048576) * 10) / 10;
      const window = { hours, bucket, timezone: tz, from: fmt.format(startMs), to: fmt.format(endMs) };

      if (macs?.length === 1) {
        const series = rows
          .map((r: any) => {
            const d = dirOf(macs![0], r);
            return { when: fmt.format(new Date(r.time)), down_mb: mb(d.down), up_mb: mb(d.up) };
          })
          .filter((r) => r.down_mb + r.up_mb >= 1);
        let down = 0, up = 0;
        for (const r of rows as any[]) {
          const d = dirOf(macs![0], r);
          down += d.down; up += d.up;
        }
        return {
          client: label(macs[0]),
          mac: macs[0],
          window,
          total_down: human(down),
          total_up: human(up),
          note: "Buckets under 1 MB are omitted.",
          series,
        };
      }

      const totals = new Map<string, { down: number; up: number }>();
      for (const r of rows as any[]) {
        const k = String(r.user ?? r.oid ?? "").toLowerCase();
        if (!k) continue;
        const t = totals.get(k) ?? { down: 0, up: 0 };
        const d = dirOf(k, r);
        t.down += d.down; t.up += d.up;
        totals.set(k, t);
      }
      const limit = Math.max(1, Number(args.limit) || 15);
      const ranked = [...totals.entries()]
        .sort((a, b) => b[1].down + b[1].up - (a[1].down + a[1].up))
        .slice(0, limit)
        .map(([mac, t]) => ({
          client: label(mac), mac,
          down: human(t.down), up: human(t.up), total_bytes: t.down + t.up,
        }));
      return { window, clients: ranked.length, top: ranked };
    },
  },

  {
    name: "client_sessions",
    description:
      "When clients joined and left the network, for answering 'when did the iPad connect?' or 'is this device dropping out?'. Each row is one association, with the AP it was on, how long it lasted, and how many times it roamed between APs during that session. Roams are reported separately so they are not mistaken for disconnects.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filter to a device by name, hostname or MAC." },
        hours: { type: "number", description: "How far back to look. Default 24." },
        limit: { type: "number", description: "Max sessions to return (default 50)." },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const hours = Math.min(720, Math.max(1, Number(args.hours) || 24));
      const endSec = Math.floor(Date.now() / 1000);
      const startSec = endSec - hours * 3600;

      const [sessions, devices, tz] = await Promise.all([
        client.sessions(startSec, endSec),
        client.devices(),
        client.siteTimezone(),
      ]);
      const apName = new Map<string, string>(
        devices.filter((d) => d.mac).map((d) => [String(d.mac).toLowerCase(), d.name || d.model]),
      );
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      });
      const dur = (s: number) => {
        if (s == null) return null;
        const h = Math.floor(s / 3600);
        const m = Math.round((s % 3600) / 60);
        return h ? `${h}h ${m}m` : `${m}m`;
      };

      const q = args.search ? String(args.search).toLowerCase() : null;
      const shaped = (sessions as any[])
        .filter((s) =>
          !q || [s.name, s.hostname, s.mac].some((f) => String(f ?? "").toLowerCase().includes(q)),
        )
        .sort((a, b) => (b.assoc_time ?? 0) - (a.assoc_time ?? 0))
        .slice(0, Math.max(1, Number(args.limit) || 50))
        .map((s) => ({
          client: s.name || s.hostname || s.mac,
          mac: s.mac,
          connected: s.assoc_time ? fmt.format(s.assoc_time * 1000) : null,
          // There is no disconnect field; it is assoc_time + duration.
          disconnected:
            s.assoc_time && s.duration ? fmt.format((s.assoc_time + s.duration) * 1000) : null,
          duration: dur(s.duration),
          ap: s.is_wired ? "wired" : apName.get(String(s.ap_mac).toLowerCase()) ?? s.ap_mac ?? null,
          roams: Array.isArray(s.roaming_sessions) ? s.roaming_sessions.length : 0,
          guest: !!s.is_guest,
          down: human(s.tx_bytes ?? 0),
          up: human(s.rx_bytes ?? 0),
          satisfaction: s.satisfaction_avg ?? s.satisfaction ?? null,
        }));
      return { window: { hours, timezone: tz }, count: shaped.length, sessions: shaped };
    },
  },

  {
    name: "rename_client",
    description:
      "Set the display name of a known client, identified by MAC address. This is the only tool that writes to UniFi: it changes a label in the client list and never touches network configuration. Returns the previous name so the change can be reversed.",
    inputSchema: {
      type: "object",
      properties: {
        mac: {
          type: "string",
          description: "MAC address of the client to rename, e.g. aa:bb:cc:dd:ee:ff.",
        },
        name: { type: "string", description: "New display name." },
      },
      required: ["mac", "name"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const mac = String(args.mac ?? "").trim().toLowerCase();
      const name = String(args.name ?? "").trim();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
        throw new Error(`Not a MAC address: ${args.mac}`);
      }
      if (!name || name.length > 128) throw new Error("Name must be 1-128 characters.");

      // Look the client up by MAC rather than making the caller supply an
      // internal id, and capture the old name so the edit is reversible.
      const known = await client.knownClients();
      const target = known.find((u) => String(u.mac).toLowerCase() === mac);
      if (!target) throw new Error(`No client known with MAC ${mac}.`);

      const previous = target.name ?? target.hostname ?? null;
      await client.renameClient(target._id, name);
      return { mac, previous_name: previous, new_name: name, renamed: true };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
