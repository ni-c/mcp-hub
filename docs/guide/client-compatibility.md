# Client compatibility

mcp-hub speaks Streamable HTTP behind OAuth 2.1 — and, since 0.6.0, behind
admin-minted API tokens for clients that cannot do OAuth. This page says, per
client, which path to use and which quirks to expect.

The ecosystem falls into three camps.

## Camp 1 — OAuth clients (use the normal flow)

These implement the MCP authorization spec: they discover the hub through the
`.well-known` documents, obtain a `client_id`, open a browser for the password
login, and refresh silently. [Connecting clients](/guide/clients) covers the
general flow; below are the per-client notes.

Since 0.10.0 the hub accepts both registration mechanisms — [Client ID Metadata
Documents](/guide/client-registration#client-id-metadata-documents) and
[dynamic registration](/guide/client-registration#dynamic-client-registration) —
and advertises both, so each client takes whichever path it prefers. The notes
below say which one that is where it matters.

| Client | Notes |
|---|---|
| **Claude Web / Claude Code** | Reference behaviour; sends the `resource` parameter, loopback redirects match any port. |
| **Cursor** | Sends `resource`; uses fixed redirect URIs (desktop `http://localhost:8787/callback`, web `https://www.cursor.com/agents/mcp/oauth/callback`) — registered automatically via DCR. |
| **Mistral Le Chat** | Auto-detects OAuth from the 401 `WWW-Authenticate` challenge; add the connector URL, done. |
| **LibreChat** | Works via DCR. **If you use a static header instead, set `requiresOAuth: false`** — its auto-detection probes without your headers, sees the 401 and misclassifies the server as OAuth-only. |
| **Open WebUI** ≥ 0.6.31 | Choose "OAuth 2.1 (DCR)". Set `WEBUI_SECRET_KEY`, or tokens break on every container restart. If OAuth fails with a resource error, set the **OAuth Resource Parameter** option to *Include*. |
| **Gemini CLI** | Use `httpUrl` (not `url`) for Streamable HTTP. Its resource check compares strictly — connect to the exact URL the path-scoped metadata names, e.g. `https://…/paperless/mcp`, not a shortened form. [Step by step](/guide/clients#gemini-cli). |
| **qwen-code** | Also `httpUrl`. OAuth callback is fixed to port 7777 (`--oauth-redirect-uri` overrides). |
| **Kimi Code CLI** | `kimi mcp add --transport http --auth oauth <name> <url>`; re-registers with a fresh random loopback port per flow, which the hub accepts. |
| **VS Code (GitHub Copilot)** | `type: "http"` in `.vscode/mcp.json`; OAuth automatic. Recent builds identify themselves with the metadata document at `https://vscode.dev/oauth/client-metadata.json`; older ones register dynamically. Either way the redirects are `http://127.0.0.1:33418` and `https://vscode.dev/redirect`. |
| **Codex CLI** | Pass the resource when adding the server: `codex mcp add <name> --url <url> --oauth-resource <url>`; builds without that flag need `oauth_resource` written into `config.toml` by hand. Older Codex builds omit the resource on refresh — the hub tolerates that and keeps the binding from the original grant. [Step by step](/guide/clients#codex-cli). |
| **ChatGPT connectors** | Both paths work (developer mode → custom connector), but the OAuth endpoints have to be filled in by hand. CIMD with `private_key_jwt` is its preferred path and is supported since 0.10.0 — the per-connector document URL is random, so allowlist the origin `https://chatgpt.com`, never an exact URL. On the DCR path the hub plays along with its quirks: public clients get a non-expiring `client_secret` in the response. An approved registration is kept as long as it is used; see the [lifecycle rules](/guide/client-registration#registrations-do-not-accumulate). [Step by step](/guide/clients#chatgpt). |
| **Copilot Studio / M365 Copilot** | "Dynamic discovery" mode should work since the hub now issues client secrets on registration. Untested — reports welcome. |

### Which MCP revision a client speaks

Nothing on this page depends on it. The hub answers `2026-07-28` and
`2025-11-25` on every endpoint, the client picks during its opening exchange,
and it cannot tell from the answers which one it got — that is the whole point
of the [capability
matrix](/reference/standards#what-is-carried-per-revision).

One feature does depend on it: [elicitation](/guide/elicitation), where a
server asks the person at the far end a question. Over HTTP that needs a client
on `2026-07-28`.

| Client | Revision | How we know |
|---|---|---|
| **Claude Code** | `2026-07-28`, fully | Measured in the shipped binary: the multi-round-trip driver, `server/discover`, the per-request capability envelope and both typed error codes are all present. |
| everything else here | unmeasured | Assume `2025-11-25` until it is checked. Nothing breaks either way; a question from a server simply does not reach you, and the server falls back on its own. |

This table stays honest by being short. A client is listed as speaking the 2026
revision when somebody has watched it do so, not when its release notes say it
should.

Clients that omit the RFC 8707 `resource` parameter entirely are refused by
default (`invalid_target`). If you need to serve such a client, set
[`DEFAULT_RESOURCE`](/reference/environment) — tokens are then bound to that
one resource instead of rejected. They are never global.

## Camp 2 — API clients (use an API token)

These products connect **server-side** and can only pass static headers — no
browser, no OAuth. Mint them a long-lived token bound to one resource:

```sh
docker compose stop mcp-hub
docker compose run --rm --no-deps mcp-hub \
  node /app/dist/admin.js tokens create --resource hub --days 90 --label "openai"
docker compose up -d
```

The token is printed exactly once. `tokens list` shows the records,
`tokens revoke <id>` kills one immediately.

::: warning API tokens trade rotation for compatibility
No refresh, no rotation — anyone holding the token has full access to its
resource until expiry or revocation. Keep lifetimes short (90 days is a
sensible default), one token per integration so revocation is surgical, and
treat the value like a password.
:::

### OpenAI Responses API

```json
{
  "model": "gpt-5.2",
  "tools": [{
    "type": "mcp",
    "server_label": "mcp-hub",
    "server_url": "https://mcp.example.net/hub",
    "authorization": "<token>"
  }],
  "input": "…"
}
```

The `authorization` value is not stored by OpenAI and must be sent on every
request.

### xAI (Grok) API

Same shape: the remote MCP tool takes `authorization` (raw token) or a
`headers` map. No OAuth exists on this surface.

### Gemini API (`mcp_server` tool)

```json
{
  "type": "mcp_server",
  "name": "mcp_hub",
  "url": "https://mcp.example.net/hub",
  "headers": { "Authorization": "Bearer <token>" }
}
```

Note Gemini's own constraint: the tool `name` must not contain `-` — use
`mcp_hub`, not `mcp-hub`.

### Header-only chat clients

Qwen Chat (via an `mcp-remote --header` stdio shim), older Cline and Windsurf
builds, and Gemini CLI/Codex in header mode all take the same
`Authorization: Bearer <token>` header.

## Camp 3 — pre-registered OAuth clients (mint the client yourself)

Grok's web connectors, Gemini Enterprise, Copilot Studio's manual mode and
Microsoft Agent 365 do no dynamic registration: they expect a client_id and
client_secret you enter on both sides. Since 0.10.0 the hub can mint one:

```bash
mcp-hub-admin clients add --name "Gemini Enterprise" \
  --redirect-uri https://example.com/oauth/callback
```

The command prints the `client_id` and — this once — the `client_secret`, then
paste both into the connector along with the hub's authorization and token
endpoints. Add `--public` for a connector that has no secret to store; it then
authenticates with PKCE alone. Operator-minted clients count as approved the
moment you create them (you named the redirect URI, so there is nothing left to
confirm in a browser) and are exempt from the [pruning
rules](/guide/client-registration#registrations-do-not-accumulate) — one you
typed out by hand must not vanish after ninety idle days. See the [admin
CLI reference](/reference/admin-cli).

Two caveats for this camp:

- The token endpoint reads the secret from the request body
  (`client_secret_post`), which is what the AS metadata advertises. A connector
  that can only send HTTP Basic credentials will not authenticate.
- PKCE is mandatory, with no per-client opt-out. Gemini Enterprise leaves it as
  a checkbox — tick it.

Copilot Studio generates its redirect URI only *after* you create the tool, so
create the tool first and mint the client second.

## Products with no custom-MCP client at all

The Kimi consumer app, the Moonshot K2 API and DeepSeek currently have no way
to add a custom remote MCP server. Nothing the hub can do — reach those models
through a third-party client from camp 1 instead.
