# mcp-ubiquiti

A remote **MCP connector** that lets [Claude](https://claude.ai) observe your
**UniFi** network — who's connected, device health, throughput, and ISP/WAN
status — through **Ubiquiti's own cloud API**.

There is **no local proxy, tunnel, or always-on box** in your house. The
connector runs as a Cloudflare Worker and talks to `api.ui.com`, which relays
to your console over the link it already maintains. Works behind CGNAT.

```
Claude  ──OAuth──▶  Cloudflare Worker  ──X-API-KEY──▶  api.ui.com  ──▶  your UniFi console
        (your Google login)          (this repo)      (Ubiquiti cloud)
```

## What Claude can see

Read-only in this first release — it observes, it does not reconfigure:

| Tool | What it returns |
|------|-----------------|
| `network_overview` | Device/client counts, ISP, WAN uptime, tx-retry |
| `list_clients` | Connected clients: IP, MAC, VLAN, SSID, live throughput |
| `list_devices` | Gateways/switches/APs: online state, model, firmware, client count |
| `list_wifi` | Configured SSIDs, security mode, VLAN mapping (no passphrases) |
| `list_networks` | Networks/VLANs and their VLAN IDs |

## Security model

- **Access is bound to one Google account.** OAuth login is required, and the
  Worker rejects any authenticated email that isn't on the allowlist
  (`ALLOWED_EMAIL`). Nobody else can complete the flow, even with the URL.
- **All secrets live as encrypted Cloudflare secrets**, never in the repo. The
  `.gitignore` also blocks `.dev.vars` and any `*.rtf` key-scratch files.
- **The UniFi key never reaches Claude** — it stays server-side in the Worker.

## Prerequisites

- A UniFi console (firmware ≥ 5.0.3) adopted into Site Manager.
- A [Cloudflare](https://dash.cloudflare.com) account (free tier is fine).
- A Google account (used as the login identity).

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

### 3. Create a Google OAuth client

[console.cloud.google.com](https://console.cloud.google.com) → **APIs &
Services → Credentials → Create OAuth client ID → Web application**. Add the
authorized redirect URI for your Worker (printed during `wrangler deploy`, of
the form `https://mcp-ubiquiti.<subdomain>.workers.dev/callback`). Note the
client ID and secret. The Google address permitted to use the connector is
set as the `ALLOWED_EMAIL` secret in step 5.

### 4. Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the returned id into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 5. Set secrets

```bash
npx wrangler secret put UNIFI_API_KEY        # the Site Manager API key
npx wrangler secret put UNIFI_HOST_ID        # console id from step 2
npx wrangler secret put ALLOWED_EMAIL        # the one Google account allowed in
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 6. Deploy

```bash
npm run deploy
```

### 7. Add to Claude

In Claude → **Settings → Connectors → Add custom connector**, paste your
Worker URL (`https://mcp-ubiquiti.<subdomain>.workers.dev/mcp`). Claude will
walk you through the Google login; only `ALLOWED_EMAIL` succeeds.

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
