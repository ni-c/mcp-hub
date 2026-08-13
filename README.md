# mcp-hub

[![CI](https://github.com/ni-c/mcp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ni-c/mcp-hub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fmcp-hub)](https://www.npmjs.com/package/@ni-c/mcp-hub)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fmcp-hub)](https://www.npmjs.com/package/@ni-c/mcp-hub)
[![Container](https://img.shields.io/badge/ghcr.io-ni--c%2Fmcp--hub-2496ED?logo=docker&logoColor=white)](https://github.com/ni-c/mcp-hub/pkgs/container/mcp-hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-mcp--hub.ni--c.de-4f46e5)](https://mcp-hub.ni-c.de)

📖 **Full documentation: <https://mcp-hub.ni-c.de>**

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
stays interchangeable). Install stdio server binaries at a reviewed, exact
version in your image; do not download mutable packages at runtime:

```json
{
  "mcpServers": {
    "paperless": {
      "command": "paperless-mcp",
      "args": [],
      "env": { "PAPERLESS_API_TOKEN": "${PAPERLESS_API_TOKEN}" }
    },
    "homeassistant": {
      "type": "http",
      "url": "http://homeassistant:8123/api/mcp",
      "headers": { "Authorization": "Bearer ${HA_TOKEN}" }
    },
    "private-thing": { "command": "some-mcp", "args": [], "hub": false }
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
`login`, `consent`, `health`, `livez`, `revoke`.

All stdio children share the hub's Unix user and can read its mounted files.
Only install fully trusted stdio servers. Put servers with a different trust
level in separate containers/hosts and connect them as remote HTTP/SSE servers;
see [SECURITY.md](SECURITY.md).

For a custom image, pin every package to an exact version:

```dockerfile
FROM ghcr.io/ni-c/mcp-hub:0.5.0
USER root
RUN npm install -g your-mcp-package@1.2.3
USER node
```

### Environment

| Variable | Required | Description |
|---|---|---|
| `EXTERNAL_URL` | yes | Public base URL, e.g. `https://mcp.example.net` (no path) |
| `PASSWORD_HASH` | one of | bcrypt hash of the login password (`htpasswd -bnBC 10 "" 'pw' \| tr -d ':\n'`) |
| `PASSWORD` | one of | plain-text alternative to `PASSWORD_HASH` |
| `TRUSTED_PROXIES` | no | comma-separated IPs/CIDRs allowed to set `X-Forwarded-*` (see below) |
| `RESOURCE_BOUND_TOKENS` | no | RFC 8707 tokens bound to `/hub` or one `/<name>/mcp`, default `true`; set `false` only to keep pre-0.5 unbound tokens working |
| `MCP_BODY_LIMIT` | no | authenticated MCP JSON body limit, default `1mb` |
| `MCP_REQUESTS_PER_MINUTE` | no | limit per OAuth client, default `120` |
| `MCP_MAX_CONCURRENT_REQUESTS` | no | in-flight limit per OAuth client, default `4` |
| `HTTP_HEADERS_TIMEOUT_MS` | no | Node HTTP header timeout, default `10000` |
| `HTTP_REQUEST_TIMEOUT_MS` | no | complete request timeout, default `310000` (slightly above the tool-call timeout) |
| `PORT` | no | listen port (default 80 in the image, 3000 outside) |
| `CONFIG_PATH` | no | default `/config/mcp.json` |
| `DATA_PATH` | no | default `/data` |
| `LOG_FILE` | no | additionally mirror all log output into this file, e.g. `/data/mcp-hub.log` (see below) |

`/data` holds the Ed25519 JWT key, registered OAuth clients, approvals and
refresh tokens. **Mount it as a volume** — recreating it invalidates every
connector authorization.

Every access token is bound to one resource. The OAuth client includes the
resource advertised by the endpoint's RFC 9728 document — no client-side
configuration needed — and the resulting token is valid only there: a token for
`/paperless/mcp` cannot call `/hub`, `/health` or another server. The shorter
`/<name>` route is canonicalized to `/<name>/mcp`.

`RESOURCE_BOUND_TOKENS=false` turns this off and is a migration mode for
deployments from 0.4 and earlier, where tokens were issued without a resource
and reach every path. The hub logs a warning while it is set. Removing it
invalidates those unbound tokens, so every connector authorizes once more.

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
docker pull ghcr.io/ni-c/mcp-hub:0.5.0
```

Tags: `latest` (tip of `main`), `X.Y.Z` and `X.Y` (releases), and
`sha-<commit>` for a specific build.

Use a version tag instead of `latest` for controlled updates. For an immutable
deployment, record the resolved digest from `docker image inspect` and use
`ghcr.io/ni-c/mcp-hub:<version>@sha256:<digest>` in Compose.

With compose, copy the example and point it at the image instead of building:

```yaml
services:
  mcp-hub:
    image: ghcr.io/ni-c/mcp-hub:0.5.0   # replaces `build: .`; pin a digest in production
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
  ghcr.io/ni-c/mcp-hub:0.5.0
```

Update to a newer image with `docker compose pull && docker compose up -d`
(or `docker pull …`, then recreate the container).

### Option B — build from source

```sh
cp docker-compose.example.yml docker-compose.yml   # adjust
cp mcp.json.example mcp.json                        # adjust
docker compose up -d --build
```

### Option C — npm (without a container)

```sh
CONFIG_PATH=./mcp.json DATA_PATH=./data PASSWORD_HASH='...' \
  npx @ni-c/mcp-hub
```

Installs as [`@ni-c/mcp-hub`](https://www.npmjs.com/package/@ni-c/mcp-hub)
(the unscoped npm name belongs to an unrelated project) and provides the
`mcp-hub` and `mcp-hub-admin` binaries. The container remains the recommended
deployment — it provides the isolation, read-only root filesystem and resource
limits that SECURITY.md assumes.

Reverse-proxy requirements: TLS termination, WebSockets/SSE allowed (proxy
buffering off, a request timeout above 310 seconds, a request-body limit at or
below `MCP_BODY_LIMIT`, and pass `X-Forwarded-Proto`/`Host`.

Connect from Claude Web: add a custom connector with URL
`https://<host>/hub` (or `https://<host>/<name>/mcp` for one server), log in
once with the password. Claude Code: `claude mcp add -t http name https://<host>/<name>/mcp`.

Each client is confirmed once. Entering the password approves the client that
asked; while a login session is still valid, a client you have not seen before
gets an explicit *Approve / Deny* page instead of a code. Approved clients
reconnect silently from then on.

List clients or revoke one while the main container is stopped (both commands
mount the same `/data`; stopping avoids concurrent state writers):

```sh
docker compose stop mcp-hub
docker compose run --rm --no-deps mcp-hub node /app/dist/admin.js clients list
docker compose run --rm --no-deps mcp-hub node /app/dist/admin.js clients revoke CLIENT_ID
docker compose up -d
```

Revocation removes the approval and all refresh tokens and immediately rejects
already-issued access tokens. The next connection needs explicit approval.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/<name>`, `/<name>/mcp` | Bearer | Streamable HTTP endpoint of one server |
| `/hub` | Bearer | aggregate endpoint with the 4 meta-tools |
| `/livez` | none | minimal process liveness (`200`) |
| `/health` | Bearer | per-server status (`200` all up / `503` degraded) |
| `/authorize`, `/token`, `/register`, `/login`, `/consent`, `/revoke` | — | OAuth 2.1 + DCR |
| `/.well-known/oauth-authorization-server[/…]` | none | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource[/…]` | none | RFC 9728 metadata (path-scoped) |

## Notes & limitations

- Stateless transport: server-initiated notifications (`listChanged`,
  subscriptions, sampling) are not delivered to clients. Tool/resource/prompt
  request-response works fully; the hub's tool cache does follow
  `tools/list_changed` internally.
- Access tokens are self-contained 15-minute JWTs. Revoking a client rejects
  its existing JWTs and removes all of its refresh tokens. Refresh tokens
  rotate; replaying a token
  that was already rotated away revokes its whole chain, and a refresh cannot
  ask for more scope than the original grant.
- Upstream auth is fully decoupled from the hub's own OAuth: an expired
  upstream token just marks that one server `down` (503 on its path, visible
  in `/health`) — clients never see the upstream's 401.
- One login can approve multiple connectors, but each token is valid only for
  its requested server or `/hub`. Registration remains open as the MCP
  specification intends; a client only receives codes after confirmation and
  only at the confirmed redirect target.
- Failed logins are rate-limited (10/15 min per IP) and logged as
  `mcp-hub: authentication failure from <ip>` for fail2ban.
- Auth pages deny framing and carry a restrictive CSP. MCP bodies are parsed
  only after bearer verification and are bounded by size, per-client request
  rate and per-client concurrency.

### Logging to a file for fail2ban

`LOG_FILE=/data/mcp-hub.log` mirrors every log line into that file, one line
per entry with an ISO-8601 UTC prefix, while leaving the console output alone —
so `docker logs` keeps working. A jail then reads the file directly:

```ini
# /etc/fail2ban/filter.d/mcp-hub-auth.conf
[Definition]
failregex = mcp-hub: authentication failure from <HOST>\s*$
            mcp-hub: login rate limit exceeded from <HOST>\s*$
            mcp-hub: consent with an invalid CSRF token from <HOST>\s*$
ignoreregex =
```

Only the hub's own lines are mirrored — the stdio children inherit stderr
directly, so their output stays in the container log and the file stays small.
Rotate it with logrotate (`copytruncate`, since the hub holds the file open).

Why not read the container's own logs instead: the Docker `json-file` path
contains the container ID and changes on every recreate, and the `journald`
driver maps **all** stderr to priority `err` — since an MCP server must keep
stdout free for the protocol and therefore logs to stderr, every ordinary line
would show up as a system error and drown out host monitoring.

Bans belong in the `DOCKER-USER` chain (`banaction = iptables-allports`) when
the hub is published through a container-based reverse proxy: that traffic
arrives via DNAT and `FORWARD`, and never passes `INPUT`.

## Development

```sh
npm install
npm test           # vitest: config, OAuth flow, proxy E2E, hub, hot reload
npm run dev        # tsx, needs EXTERNAL_URL/PASSWORD/CONFIG_PATH/DATA_PATH
```
