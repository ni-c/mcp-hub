# mcp-hub

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
    "private-thing": { "command": "uvx", "args": ["some-mcp"], "hub": false }
  }
}
```

Only stdio servers are supported (`type: "http"`/`"sse"` entries are rejected).
`"hub": false` hides a server from the `/hub` aggregate; its own path keeps
working. Reserved names: `mcp`, `hub`, `authorize`, `token`, `register`,
`login`, `health`, `revoke`.

### Environment

| Variable | Required | Description |
|---|---|---|
| `EXTERNAL_URL` | yes | Public base URL, e.g. `https://mcp.example.net` (no path) |
| `PASSWORD_HASH` | one of | bcrypt hash of the login password (`htpasswd -bnBC 10 "" 'pw' \| tr -d ':\n'`) |
| `PASSWORD` | one of | plain-text alternative to `PASSWORD_HASH` |
| `TRUSTED_PROXIES` | no | comma-separated IPs/CIDRs allowed to set `X-Forwarded-*` |
| `PORT` | no | listen port (default 80 in the image, 3000 outside) |
| `CONFIG_PATH` | no | default `/config/mcp.json` |
| `DATA_PATH` | no | default `/data` |

`/data` holds the Ed25519 JWT key, registered OAuth clients and refresh
tokens. **Mount it as a volume** — recreating it invalidates every connector
authorization.

## Running

```sh
cp docker-compose.example.yml docker-compose.yml   # adjust
cp mcp.json.example mcp.json                       # adjust
docker compose up -d --build
```

Reverse-proxy requirements: TLS termination, WebSockets/SSE allowed (proxy
buffering off, long read timeouts), and pass `X-Forwarded-Proto`/`Host`.

Connect from Claude Web: add a custom connector with URL
`https://<host>/hub` (or `https://<host>/<name>/mcp` for one server), log in
once with the password. Claude Code: `claude mcp add -t http name https://<host>/<name>/mcp`.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/<name>`, `/<name>/mcp` | Bearer | Streamable HTTP endpoint of one server |
| `/hub` | Bearer | aggregate endpoint with the 4 meta-tools |
| `/health` | none | per-server status (`200` all up / `503` degraded) |
| `/authorize`, `/token`, `/register`, `/login`, `/revoke` | — | OAuth 2.1 + DCR |
| `/.well-known/oauth-authorization-server[/…]` | none | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource[/…]` | none | RFC 9728 metadata (path-scoped) |

## Notes & limitations

- Stateless transport: server-initiated notifications (`listChanged`,
  subscriptions, sampling) are not delivered to clients. Tool/resource/prompt
  request-response works fully; the hub's tool cache does follow
  `tools/list_changed` internally.
- Access tokens are self-contained 24 h JWTs and cannot be revoked
  individually; refresh tokens rotate and can be revoked.
- One login secures everything: any valid token may call every server.
- Failed logins are rate-limited (10/15 min per IP) and logged as
  `mcp-hub: authentication failure from <ip>` for fail2ban.

## Development

```sh
npm install
npm test           # vitest: config, OAuth flow, proxy E2E, hub, hot reload
npm run dev        # tsx, needs EXTERNAL_URL/PASSWORD/CONFIG_PATH/DATA_PATH
```
