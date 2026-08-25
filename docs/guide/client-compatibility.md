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

## Camp 3 — pre-registered OAuth clients (not yet supported)

Grok's web connectors, Gemini Enterprise, Copilot Studio's manual mode and
Microsoft Agent 365 do no dynamic registration: they expect a client_id and
client_secret you enter on both sides. The hub cannot pre-register clients
yet — that is the next compatibility stage, tracked in the
[roadmap issues](https://github.com/ni-c/mcp-hub/issues). Until then these
connect only where an API token can be smuggled in as a header, which none of
them offer — so: not yet.

## Products with no custom-MCP client at all

The Kimi consumer app, the Moonshot K2 API and DeepSeek currently have no way
to add a custom remote MCP server. Nothing the hub can do — reach those models
through a third-party client from camp 1 instead.
