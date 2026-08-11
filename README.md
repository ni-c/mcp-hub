# mcp-hub

[![CI](https://github.com/ni-c/mcp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ni-c/mcp-hub/actions/workflows/ci.yml)
[![Container](https://img.shields.io/badge/ghcr.io-ni--c%2Fmcp--hub-2496ED?logo=docker&logoColor=white)](https://github.com/ni-c/mcp-hub/pkgs/container/mcp-hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Serve many stdio MCP servers from **one container**, published over HTTPS for
[Claude Web custom connectors](https://claude.ai), Claude Code and any other
Streamable-HTTP MCP client — with a built-in OAuth 2.1 login protected by a
single password.

```
Claude ──TLS──> reverse proxy ──> mcp-hub (one Node process)
                                   ├─ OAuth 2.1 AS (DCR, PKCE, password login)
                                   ├─ /<name>, /<name>/mcp   one path per server
                                   ├─ /hub                   4 meta-tools for all servers
                                   └─ supervisor: one stdio child per server, auto-restart
```

## Why

Wrapping each stdio MCP server in its own auth-proxy container costs a full
image, an OAuth stack, a hostname and a compose stack *per server*. mcp-hub
replaces N containers with one process:

- **Config is exactly Claude Code's `mcpServers` format** — copy entries 1:1.
- **Path-based routing**: `https://host/paperless`, `https://host/homeassistant`, …
- **`/hub` aggregate**: register a *single* connector and reach every server
  through 4 meta-tools (`list_servers`, `list_tools`, `get_tool_schema`,
  `call_tool`) without flooding the model context with N×tools schemas.
- **Supervision**: children are spawned at boot, pinged, and restarted with
  exponential backoff when they die. A down server answers 503, not silence.
- **Hot reload**: edits to `mcp.json` start/stop/restart only the affected
  servers.
- **Stateless Streamable HTTP**: no session state, so claude.ai's
  reconnect-without-DELETE behaviour cannot leak processes or memory.
- **No database**: state is one JSON file plus a JWT key under `/data`.

## Configuration

`/config/mcp.json` — identical to Claude Code (`${VAR}` expands from the
container environment; unknown fields are ignored by Claude Code, so the file
stays interchangeable):

```json
{
  "mcpServers": {
    "paperless": {
      "command": "npx",
      "args": ["-y", "paperless-mcp"],
      "env": { "PAPERLESS_API_TOKEN": "${PAPERLESS_API_TOKEN}" }
    },
    "homeassistant": {
      "type": "http",
      "url": "http://homeassistant:8123/api/mcp",
      "headers": { "Authorization": "Bearer ${HA_TOKEN}" }
    },
    "private-thing": { "command": "uvx", "args": ["some-mcp"], "hub": false }
  }
}
```

Stdio servers (`command`/`args`/`env`) are spawned as supervised child
processes. Remote servers (`type: "http"` or `"sse"` with `url` and optional
`headers`) are connected as MCP clients with the configured headers injected
on every request — the same supervision (ping, backoff reconnect, hot reload)
applies. Upstreams that require their own *interactive* OAuth cannot be
configured with static headers; bridge those with an
[`mcp-remote`](https://github.com/geelen/mcp-remote) stdio entry and persist
its token cache (`MCP_REMOTE_CONFIG_DIR`) under `/data`.
`"hub": false` hides a server from the `/hub` aggregate; its own path keeps
working. Reserved names: `mcp`, `hub`, `authorize`, `token`, `register`,
`login`, `consent`, `health`, `revoke`.

### Environment

| Variable | Required | Description |
|---|---|---|
| `EXTERNAL_URL` | yes | Public base URL, e.g. `https://mcp.example.net` (no path) |
| `PASSWORD_HASH` | one of | bcrypt hash of the login password (`htpasswd -bnBC 10 "" 'pw' \| tr -d ':\n'`) |
| `PASSWORD` | one of | plain-text alternative to `PASSWORD_HASH` |
| `TRUSTED_PROXIES` | no | comma-separated IPs/CIDRs allowed to set `X-Forwarded-*` (see below) |
| `PORT` | no | listen port (default 80 in the image, 3000 outside) |
| `CONFIG_PATH` | no | default `/config/mcp.json` |
| `DATA_PATH` | no | default `/data` |

`/data` holds the Ed25519 JWT key, registered OAuth clients, approvals and
refresh tokens. **Mount it as a volume** — recreating it invalidates every
connector authorization.

`TRUSTED_PROXIES` decides what `req.ip` is, and therefore what the login rate
limiter counts. List **only** your own reverse proxy, and make sure it
*overwrites* `X-Forwarded-For` rather than appending to it — otherwise a
client can supply its own address and rotate it to sidestep the per-IP limit.
If the variable is unset, every request appears to come from the proxy and
per-IP limiting degrades to a single global counter (the hub logs a warning
at startup). A global cap of 100 failures per 15 minutes applies either way.

## Running

### Option A — prebuilt image from GHCR (recommended)

Published on every push to `main` and every `vX.Y.Z` release tag, for
`linux/amd64` and `linux/arm64`. Browse the versions on the
[package page](https://github.com/ni-c/mcp-hub/pkgs/container/mcp-hub).

```sh
docker pull ghcr.io/ni-c/mcp-hub:latest
```

Tags: `latest` (tip of `main`), `X.Y.Z` and `X.Y` (releases), and
`sha-<commit>` for a specific build.

With compose, copy the example and point it at the image instead of building:

```yaml
services:
  mcp-hub:
    image: ghcr.io/ni-c/mcp-hub:latest   # replaces `build: .`
    # ...rest of docker-compose.example.yml unchanged
```

```sh
cp docker-compose.example.yml docker-compose.yml   # adjust, swap build → image
cp mcp.json.example mcp.json                        # adjust
mkdir -p data && sudo chown -R 1000:1000 data       # container runs as uid 1000
docker compose up -d
```

Or without compose:

```sh
mkdir -p data && sudo chown -R 1000:1000 data       # container runs as uid 1000
docker run -d --name mcp-hub \
  -p 127.0.0.1:7690:80 \
  -e EXTERNAL_URL="https://mcp.example.net" \
  -e PASSWORD_HASH="$(htpasswd -bnBC 10 '' 'yourpassword' | tr -d ':\n')" \
  -e TRUSTED_PROXIES="192.168.1.0/24" \
  -v "$PWD/mcp.json:/config/mcp.json:ro" \
  -v "$PWD/data:/data" \
  ghcr.io/ni-c/mcp-hub:latest
```

Update to a newer image with `docker compose pull && docker compose up -d`
(or `docker pull …`, then recreate the container).

### Option B — build from source

```sh
cp docker-compose.example.yml docker-compose.yml   # adjust
cp mcp.json.example mcp.json                        # adjust
docker compose up -d --build
```

Reverse-proxy requirements: TLS termination, WebSockets/SSE allowed (proxy
buffering off, long read timeouts), and pass `X-Forwarded-Proto`/`Host`.

Connect from Claude Web: add a custom connector with URL
`https://<host>/hub` (or `https://<host>/<name>/mcp` for one server), log in
once with the password. Claude Code: `claude mcp add -t http name https://<host>/<name>/mcp`.

Each client is confirmed once. Entering the password approves the client that
asked; while a login session is still valid, a client you have not seen before
gets an explicit *Approve / Deny* page instead of a code. Approved clients
reconnect silently from then on. To withdraw an approval, stop the container,
remove the entry from `approvals` in `/data/state.json` and start it again —
the client then has to be confirmed the next time it connects.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/<name>`, `/<name>/mcp` | Bearer | Streamable HTTP endpoint of one server |
| `/hub` | Bearer | aggregate endpoint with the 4 meta-tools |
| `/health` | none | per-server status (`200` all up / `503` degraded) |
| `/authorize`, `/token`, `/register`, `/login`, `/consent`, `/revoke` | — | OAuth 2.1 + DCR |
| `/.well-known/oauth-authorization-server[/…]` | none | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource[/…]` | none | RFC 9728 metadata (path-scoped) |

## Notes & limitations

- Stateless transport: server-initiated notifications (`listChanged`,
  subscriptions, sampling) are not delivered to clients. Tool/resource/prompt
  request-response works fully; the hub's tool cache does follow
  `tools/list_changed` internally.
- Access tokens are self-contained 24 h JWTs and cannot be revoked
  individually; refresh tokens rotate and can be revoked. Replaying a token
  that was already rotated away revokes its whole chain, and a refresh cannot
  ask for more scope than the original grant.
- Upstream auth is fully decoupled from the hub's own OAuth: an expired
  upstream token just marks that one server `down` (503 on its path, visible
  in `/health`) — clients never see the upstream's 401.
- One login secures everything: any valid token may call every server. What a
  token is *not* is automatic — registration is open (as the MCP spec
  intends), so a client only ever receives codes after you confirmed it, and
  only at the redirect target you confirmed it for.
- Failed logins are rate-limited (10/15 min per IP) and logged as
  `mcp-hub: authentication failure from <ip>` for fail2ban.

## Development

```sh
npm install
npm test           # vitest: config, OAuth flow, proxy E2E, hub, hot reload
npm run dev        # tsx, needs EXTERNAL_URL/PASSWORD/CONFIG_PATH/DATA_PATH
```
