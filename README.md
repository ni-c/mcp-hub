# mcp-hub

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/mcp-hub/ci.yml?branch=main&label=CI)](https://github.com/ni-c/mcp-hub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fmcp-hub)](https://www.npmjs.com/package/@ni-c/mcp-hub)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fmcp-hub)](https://www.npmjs.com/package/@ni-c/mcp-hub)
[![node](https://img.shields.io/node/v/%40ni-c%2Fmcp-hub)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Fmcp-hub)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fmcp--hub-blue)](https://github.com/ni-c/mcp-hub/pkgs/container/mcp-hub)
[![docs](https://img.shields.io/badge/docs-mcp--hub.ni--c.de-informational)](https://mcp-hub.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) gateway: it serves
many stdio MCP servers from **one container**, published over HTTPS.

Lets MCP clients that cannot spawn a local process — ChatGPT connectors, Claude on
the Web and in Code, Mistral Le Chat, Cursor, LibreChat and any other
Streamable-HTTP client — reach every server behind it, with a built-in OAuth 2.1
login protected by a single password, plus long-lived API tokens for clients that
cannot do OAuth (OpenAI Responses API, xAI API, Gemini API). Per-client recipes:
[client compatibility](https://mcp-hub.ni-c.de/guide/client-compatibility).

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://mcp-hub.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://mcp-hub.ni-c.de/architecture-light.svg">
  <img src="https://mcp-hub.ni-c.de/architecture.svg" alt="MCP clients connect through a reverse proxy to mcp-hub: one Node process with an OAuth 2.1 authorization server, one path per server plus the /hub aggregate, and a supervisor keeping the stdio children and remote upstreams alive" width="800">
</picture>

![Demo: config in, hub up, servers reachable through one endpoint](https://mcp-hub.ni-c.de/demo.gif)

**Want to poke at it first?** [`demo/`](demo/) is a throwaway hub with three
fake servers — `docker compose up -d`, then point the
[MCP Inspector](https://mcp-hub.ni-c.de/guide/demo#mcp-inspector) or
[MCPJam](https://mcp-hub.ni-c.de/guide/demo#mcpjam) at it. Nothing to
configure, nothing to clean up but a volume.

## Why

Wrapping each stdio MCP server in its own auth-proxy container costs a full
image, an OAuth stack, a hostname and a compose stack _per server_. mcp-hub
replaces N containers with one process:

- **Config is exactly Claude Code's `mcpServers` format** — copy entries 1:1.
- **Path-based routing**: `https://host/paperless`, `https://host/homeassistant`, …
- **`/hub` aggregate**: register a _single_ connector and reach every server
  through 6 meta-tools (`list_servers`, `list_tools`, `get_tool_schema`,
  `call_tool`, `wake_server`, `sleep_server`) without flooding the model
  context with N×tools schemas.
- **Per-server tool filtering**: `allowTools` / `denyTools` on any server decide
  which of its tools the hub exposes — exact names or `list_*` prefixes. A
  filtered tool is hidden from `tools/list` _and_ refused if a client calls it
  anyway, before the server is even woken, so a client holding a stale schema
  cannot reach it.
- **Also without HTTP**: `mcp-hub --stdio` serves that same aggregate on
  stdin/stdout for clients that can only spawn a local process (Claude Desktop,
  Codex, …) — same `mcp.json`, no TLS, no reverse proxy, no login. Auth exists
  for the network endpoints; over stdio the trust boundary is the local user.
- **On-demand lifecycle**: stdio and docker servers start when used and sleep
  after 60 idle minutes, answering `initialize`/`tools/list` from a persistent
  snapshot meanwhile — a dozen servers cost only the memory of the ones in
  use. `keepAlive: true` exempts a server, `IDLE_TIMEOUT_MINUTES=0` the hub.
- **CIMD-first OAuth 2.1**: clients identify themselves with a [Client ID
  Metadata Document](https://mcp-hub.ni-c.de/guide/client-registration) — the
  registration-free path the MCP spec now prefers — including `private_key_jwt`
  against the keys in their own document (metadata-document clients only). RFC
  7591 dynamic registration stays advertised beside it for older clients,
  `mcp-hub-admin clients add` issues credentials by hand for anything that can
  do neither, and `CLIENT_REGISTRATION` turns either mechanism off.
- **OAuth outwards, too**: a remote server that speaks OAuth gets an `oauth`
  block instead of a static header. The hub registers itself — with credentials
  the upstream issued, via RFC 7591, or with its own client metadata document —
  then obtains and refreshes the token. `client_credentials` upstreams need no
  attention at all; where a person must sign in, `mcp-hub-admin upstream login`
  prints one URL. An upstream that needs re-authorizing shows up as one server
  `unauthorized`, not as a confusing 401 in your client.
- **Supervision**: children are pinged and restarted with exponential backoff
  when they die. A down server answers 503, not silence; a crash-looping
  server nobody uses is parked instead of restarted forever.
- **Hot reload**: edits to `mcp.json` start/stop/restart only the affected
  servers.
- **Stateless Streamable HTTP**: no session state, so claude.ai's
  reconnect-without-DELETE behaviour cannot leak processes or memory.
- **Lightweight by design**: one Node process, no database (state is one JSON
  file plus a signing key under `/data`), six runtime dependencies, and
  multi-arch images — a stated project goal is to run comfortably on a
  single-board computer like a Raspberry Pi.

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
    "private-thing": { "command": "some-mcp", "args": [], "hub": false },
    "paperless-readonly": {
      "command": "paperless-mcp",
      "allowTools": ["search_*", "get_document"],
      "denyTools": ["delete_document"]
    },
    "untrusted": {
      "type": "docker",
      "image": "ghcr.io/example/untrusted-mcp@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "network": "none",
      "memory": "256m"
    }
  }
}
```

Stdio servers (`command`/`args`/`env`) are spawned as supervised child
processes. Remote servers (`type: "http"` or `"sse"` with `url` and optional
`headers`) are connected as MCP clients with the configured headers injected
on every request — the same supervision (ping, backoff reconnect, hot reload)
applies. An upstream that speaks OAuth gets an `oauth` block instead of a
header: the hub registers itself (statically, via RFC 7591 or via a client
metadata document), obtains the token and refreshes it, with one browser visit
started from the admin CLI where the grant needs a person.
`"hub": false` hides a server from the `/hub` aggregate; its own path keeps
working. `allowTools` / `denyTools` cut finer and apply to every kind of
server: a filtered tool is absent from both `tools/list` and `/hub`, and is
refused if called anyway — before the server is woken.
Reserved names: `mcp`, `hub`, `authorize`, `token`, `register`,
`login`, `consent`, `health`, `livez`, `revoke`, `upstream`, `.well-known`.

All stdio children share the hub's Unix user and can read its mounted files.
Only install fully trusted stdio servers. A server with a different trust level
belongs in its own container — and it does not have to speak HTTP to get there:

- `type: "docker"` — the hub creates the container and talks **stdio across the
  container boundary** over the Docker API. No HTTP listener, no bearer token,
  no bridge process in the image. The hub itself never gets the Docker socket:
  a separate `mcp-hub-docker-proxy` container holds it and allows only the
  container operations `mcp.json` describes — nothing privileged, no host
  mounts, no other images. Credentials can live with the proxy (`secretsFrom`)
  so the hub process never holds them — and rotating one is just an edit: the
  proxy watches the file and recreates the sandbox with the new values.
- `type: "unix"` / `"tcp"` — you start the container, the hub connects to a
  socket. Costs the hub no privileges at all, and a Unix socket reaches a
  sandbox running with `network_mode: none`.

Both carry the newline-delimited JSON-RPC the specification asks custom
transports to reuse. See [sandboxing](https://mcp-hub.ni-c.de/guide/sandboxing)
and [SECURITY.md](SECURITY.md).

For a custom image, pin every package to an exact version:

```dockerfile
FROM ghcr.io/ni-c/mcp-hub:0.10.0   # pin @sha256:<digest> in production
USER root
RUN npm install -g your-mcp-package@1.2.3
USER node
```

### Environment

| Variable                        | Required            | Description                                                                                                                   |
| ------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `EXTERNAL_URL`                  | yes                 | Public base URL, e.g. `https://mcp.example.net` (no path)                                                                     |
| `PASSWORD_HASH`                 | one of              | bcrypt hash of the login password (`htpasswd -bnBC 10 "" 'pw' \| tr -d ':\n'`)                                                |
| `PASSWORD`                      | one of              | plain-text alternative to `PASSWORD_HASH`                                                                                     |
| `TRUSTED_PROXIES`               | no                  | comma-separated IPs/CIDRs allowed to set `X-Forwarded-*` (see below)                                                          |
| `RESOURCE_BOUND_TOKENS`         | no                  | RFC 8707 tokens bound to `/hub` or one `/<name>/mcp`, default `true`; set `false` only to keep pre-0.5 unbound tokens working |
| `DEFAULT_RESOURCE`              | no                  | server name (or `hub`) to bind tokens to when a client sends no `resource` parameter; unset → such requests are refused       |
| `MCP_BODY_LIMIT`                | no                  | authenticated MCP JSON body limit, default `1mb`                                                                              |
| `MCP_REQUESTS_PER_MINUTE`       | no                  | limit per OAuth client, default `120`                                                                                         |
| `MCP_MAX_CONCURRENT_REQUESTS`   | no                  | in-flight request limit per OAuth client, default `4`                                                                         |
| `MCP_MAX_CONCURRENT_STREAMS`    | no                  | open SSE listening streams per OAuth client — one per connected session, default `32`                                         |
| `HTTP_HEADERS_TIMEOUT_MS`       | no                  | Node HTTP header timeout, default `10000`                                                                                     |
| `HTTP_REQUEST_TIMEOUT_MS`       | no                  | complete request timeout, default `310000` (slightly above the tool-call timeout)                                             |
| `PORT`                          | no                  | listen port (default 80 in the image, 3000 outside)                                                                           |
| `CONFIG_PATH`                   | no                  | default `/config/mcp.json`                                                                                                    |
| `DATA_PATH`                     | no                  | default `/data`                                                                                                               |
| `LOG_FILE`                      | no                  | additionally mirror all log output into this file, e.g. `/data/mcp-hub.log` (see below)                                       |
| `CLIENT_REGISTRATION`           | no                  | which mechanisms a client may use for a `client_id`: `cimd`, `dcr` or both (default)                                          |
| `CIMD_ALLOWED_ORIGINS`          | no                  | bare https origins whose metadata documents are accepted; unset → any                                                         |
| `CIMD_ALLOW_PRIVATE_ADDRESSES`  | no                  | local development only; relaxes the SSRF guard, warns on every start                                                          |
| `DCR_MAX_CLIENTS`               | no                  | ceiling on stored dynamic registrations, default `500`                                                                        |
| `DCR_PENDING_TTL_HOURS`         | no                  | how long a never-approved registration is kept, default `24`                                                                  |
| `DCR_INACTIVE_DAYS`             | no                  | how long an unused approved registration is kept, default `90`                                                                |
| `IDLE_TIMEOUT_MINUTES`          | no                  | idle minutes before an on-demand server sleeps, default `60`; `0` disables it                                                 |
| `TOOL_CACHE_PATH`               | no                  | snapshots of sleeping servers, default `<DATA_PATH>/tool-cache.json`                                                          |
| `MCP_CALL_TIMEOUT_MS`           | no                  | deadline for one forwarded tool call, default `300000`                                                                        |
| `MCP_RESET_TIMEOUT_ON_PROGRESS` | no                  | let progress notifications extend that deadline, default `false`                                                              |
| `DOCKER_HOST`                   | with docker servers | the **policy proxy's** socket; a direct daemon socket fails closed                                                            |

The full table, including what applies in stdio mode, is in the
[environment reference](https://mcp-hub.ni-c.de/reference/environment).

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
_overwrites_ `X-Forwarded-For` rather than appending to it — otherwise a
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
docker pull ghcr.io/ni-c/mcp-hub:0.10.0
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
    image: ghcr.io/ni-c/mcp-hub:0.10.0 # replaces `build: .`; pin a digest in production
    # ...rest of docker-compose.example.yml unchanged
```

```sh
cp docker-compose.example.yml docker-compose.yml   # adjust, swap build → image
mkdir -p config && cp mcp.json.example config/mcp.json  # adjust
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
  -v "$PWD/config:/config:ro" \
  -v "$PWD/data:/data" \
  ghcr.io/ni-c/mcp-hub:0.10.0
```

Update to a newer image with `docker compose pull && docker compose up -d`
(or `docker pull …`, then recreate the container).

### Option B — build from source

```sh
cp docker-compose.example.yml docker-compose.yml   # adjust
mkdir -p config && cp mcp.json.example config/mcp.json  # adjust
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

Connect a client: add `https://<host>/hub` (or `https://<host>/<name>/mcp`
for one server) as a custom connector — in ChatGPT (developer mode), Claude
Web, Mistral Le Chat, Cursor, LibreChat or any other OAuth-capable MCP client —
and log in once with the password. Claude Code:
`claude mcp add -t http name https://<host>/<name>/mcp`. API-only clients
(OpenAI Responses API, xAI, Gemini API) use an admin-minted token instead —
see [client compatibility](https://mcp-hub.ni-c.de/guide/client-compatibility).

Each client is confirmed once. Entering the password approves the client that
asked; while a login session is still valid, a client you have not seen before
gets an explicit _Approve / Deny_ page instead of a code. Approved clients
reconnect silently from then on.

List clients or revoke one. The CLI shares `/data` with the running hub and
both sides re-read the state file before they touch it, so this works against a
live container — a revocation takes effect on the next request:

```sh
docker exec mcp-hub node /app/dist/admin.js clients list
docker exec mcp-hub node /app/dist/admin.js clients revoke CLIENT_ID
docker exec mcp-hub node /app/dist/admin.js clients delete CLIENT_ID
docker exec mcp-hub node /app/dist/admin.js clients prune --dry-run
```

Revocation removes the approval and all refresh tokens and immediately rejects
already-issued access tokens. The next connection needs explicit approval.
`delete` goes further and removes the registration itself, and `prune` applies
the [registration lifecycle rules](https://mcp-hub.ni-c.de/guide/client-registration)
on demand — registrations that were never approved expire after a day, unused
ones after 90 days, and a dynamically registered client can also remove its own
registration through RFC 7592.

For clients that cannot do OAuth at all — the OpenAI Responses API, the xAI
API, Gemini's `mcp_server` tool, plain-header clients — the same CLI mints
long-lived, resource-bound API tokens:

```sh
docker exec mcp-hub node /app/dist/admin.js tokens create --resource hub --days 90 --label "openai"
docker exec mcp-hub node /app/dist/admin.js tokens list
docker exec mcp-hub node /app/dist/admin.js tokens revoke TOKEN_ID
```

The token is printed once and never stored; `tokens revoke` takes effect
immediately. Per-client recipes:
[client compatibility](https://mcp-hub.ni-c.de/guide/client-compatibility).

## Endpoints

| Path                                                                 | Auth                       | Purpose                                                           |
| -------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `/<name>`, `/<name>/mcp`                                             | Bearer                     | Streamable HTTP endpoint of one server                            |
| `/hub`                                                               | Bearer                     | aggregate endpoint with the 6 meta-tools                          |
| `/livez`                                                             | none                       | minimal process liveness (`200`)                                  |
| `/health`                                                            | Bearer                     | per-server status (`200` all up / `503` degraded)                 |
| `/authorize`, `/token`, `/register`, `/login`, `/consent`, `/revoke` | —                          | OAuth 2.1 · CIMD + DCR                                            |
| `/register/<client_id>`                                              | registration token         | RFC 7592: a client reads, changes or removes its own registration |
| `/upstream/callback`                                                 | signed state + hub session | where an upstream returns after `upstream login`                  |
| `/.well-known/mcp-hub-client/<id>.json`                              | none                       | the hub's own client metadata document, one per `cimd` upstream   |
| `/.well-known/oauth-authorization-server[/…]`                        | none                       | RFC 8414 metadata                                                 |
| `/.well-known/oauth-protected-resource[/…]`                          | none                       | RFC 9728 metadata (path-scoped)                                   |

## Notes & limitations

- Stateless transport: server-initiated notifications (`listChanged`,
  subscriptions, sampling) are not delivered to clients. Tool/resource/prompt
  request-response works fully; the hub's tool cache does follow
  `tools/list_changed` internally.
- Access tokens are opaque and last 15 minutes. Revoking a client takes effect
  on its next request rather than when the token expires — the token is a
  reference to a stored record, so withdrawing it is a deletion. Refresh tokens
  rotate; replaying one that was already rotated away is treated as a leak and
  revokes the whole grant, access tokens included.
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
