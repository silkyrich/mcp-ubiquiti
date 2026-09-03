# mcp-ubiquiti

A remote **MCP connector** that lets [Claude](https://claude.ai) observe your
**UniFi** network — who's connected, device health, throughput, and ISP/WAN
status — through **Ubiquiti's own cloud API**.

There is **no local proxy, tunnel, or always-on box** in your house. The
connector runs as a Cloudflare Worker and talks to `api.ui.com`, which relays
to your console over the link it already maintains. Works behind CGNAT.

```
Claude  ──OAuth──▶  Cloudflare Worker  ──X-API-KEY──▶  api.ui.com  ──▶  your UniFi console
     (via Cloudflare Access)         (this repo)      (Ubiquiti cloud)
```

## What Claude can see

Observation only, with one narrow exception (`rename_client`). Nothing here
changes network configuration:

| Tool | What it returns |
|------|-----------------|
| `network_overview` | Device/client counts, ISP, WAN uptime, tx-retry |
| `list_clients` | Connected clients: IP, MAC, VLAN, SSID, live throughput, plus (wifi) which AP they're on, signal in dBm, SNR, band, channel, and the negotiated PHY (Wi-Fi generation, channel width, spatial streams, link rate) |
| `list_devices` | Gateways/switches/APs: online state, model, firmware, client count |
| `list_wifi` | Configured SSIDs, security mode, VLAN mapping (no passphrases) |
| `list_networks` | Networks/VLANs and their VLAN IDs |
| `rename_client` | **(write)** Sets a client's display name, by MAC. Returns the previous name so the change can be reversed. |

## Security model

- **Access is bound to one identity.** Login is delegated to Cloudflare Access,
  whose policies perform the real identity check. The Worker then rejects any
  authenticated email that isn't `ALLOWED_EMAIL`, so nobody else can complete
  the flow even with the URL.
- **All secrets live as encrypted Cloudflare secrets**, never in the repo. The
  `.gitignore` also blocks `.dev.vars` and any `*.rtf` key-scratch files.
- **The UniFi key never reaches Claude** — it stays server-side in the Worker.
- **Exactly one write exists.** `rename_client` sets a display label and
  nothing else; there is no code path to SSID, firewall, or DHCP settings.

## Prerequisites

- A UniFi console (firmware ≥ 5.0.3) adopted into Site Manager.
- A [Cloudflare](https://dash.cloudflare.com) account (free tier is fine).
- Cloudflare Zero Trust (Access) enabled on that account, with at least one
  identity provider configured.

## Setup

### 1. Clone & install

```bash
git clone https://github.com/<you>/mcp-ubiquiti.git
cd mcp-ubiquiti
npm install
```

### 2. Create a UniFi API key

At [unifi.ui.com](https://unifi.ui.com) → **Settings → API Keys → Create New
API Key**. Give it **Site Manager** + **Network** scope. Copy the key (shown
once).

Find your console's host id (you'll set it as a secret in step 5):

```bash
curl -s -H "X-API-KEY: <your-key>" https://api.ui.com/v1/hosts | jq '.data[].id'
```

### 3. Create a Cloudflare Access OIDC app

Login is delegated to **Cloudflare Access**, so it uses whichever identity
providers you've already configured there (Google, Entra, one-time PIN) — there
is no third-party developer console to set up.

In [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Access →
Applications → Add an application → SaaS**, choose **OIDC** and set the
redirect URL to your Worker's callback (printed during `wrangler deploy`, of
the form `https://mcp-ubiquiti.<subdomain>.workers.dev/callback`).

Note the **client ID**, **client secret**, and your **team domain**
(`your-team.cloudflareaccess.com`). Add an Access policy restricting the app to
the identity you want. `ALLOWED_EMAIL` (step 5) is then a second, local check
so the connector stays bound to one person even if the policy is later widened.

### 4. Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the returned id into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 5. Set secrets

```bash
npx wrangler secret put UNIFI_API_KEY        # the Site Manager API key
npx wrangler secret put UNIFI_HOST_ID        # console id from step 2
npx wrangler secret put ALLOWED_EMAIL        # the one identity allowed in
npx wrangler secret put ACCESS_TEAM_DOMAIN   # your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
```

### 6. Deploy

```bash
npm run deploy
```

### 7. Add to Claude

In Claude → **Settings → Connectors → Add custom connector**, paste your
Worker URL (`https://mcp-ubiquiti.<subdomain>.workers.dev/mcp`). Claude will
walk you through the Cloudflare Access login; only `ALLOWED_EMAIL` succeeds.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values (gitignored)
npm run dev
```

## Roadmap

- Event/log retrieval (client connect/disconnect, admin changes).
- Historical stats (per-client/day, WAN latency trends).
- Opt-in write tools (SSID, firewall) behind an explicit confirmation flag.

## License

MIT
