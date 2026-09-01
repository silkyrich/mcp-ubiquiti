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
      "List clients currently connected, with IP, MAC, VLAN, SSID (or wired), and live throughput. Optionally filter by a search string matched against name/hostname/IP/MAC.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive filter over name/hostname/ip/mac." },
        limit: { type: "number", description: "Max clients to return (default 50)." },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const search = (args.search ?? "").toLowerCase();
      const limit = Number.isFinite(args.limit) ? Math.max(1, args.limit) : 50;
      const clients = await client.clients();
      const shaped = clients
        .map((c) => ({
          name: c.name || c.hostname || "(unknown)",
          ip: c.ip,
          mac: c.mac,
          vlan: c.vlan ?? null,
          connection: c.is_wired ? "wired" : (c.essid ?? "wifi"),
          rx: c.rx_bytes ?? 0,
          tx: c.tx_bytes ?? 0,
          total_h: human((c.rx_bytes ?? 0) + (c.tx_bytes ?? 0)),
          uptime_s: c.uptime,
        }))
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
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
