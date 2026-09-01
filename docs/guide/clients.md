# Connecting clients

Every MCP endpoint the hub exposes is Streamable HTTP behind an OAuth 2.1
bearer token. Any client that supports remote MCP servers with OAuth can use
it — Claude is shown here as the reference; the full per-client list, from
ChatGPT to the header-only APIs, lives on the
[client compatibility](/guide/client-compatibility) page.

## Which URL to register

| URL | Use it for |
|---|---|
| `https://mcp.example.net/hub` | one connector for everything, six meta-tools, minimal context cost |
| `https://mcp.example.net/<name>/mcp` | a single server with its native tools, for the ones you use constantly |

Both can be registered at the same time. A common setup is one `/hub`
connector plus two or three direct connectors, with those servers marked
`"hub": false` so they are not offered twice.

The short form `https://mcp.example.net/<name>` works as well and is
canonicalized to `/<name>/mcp`.

## Claude Web

Settings → Connectors → **Add custom connector**, then enter the URL.

Claude identifies itself — through dynamic client registration, or a [metadata
document](/guide/client-registration) on builds that support one — opens the
hub's login page, and asks for the password. Entering it correctly signs you in
and approves that client in one step. From then on the connector reconnects on
its own.

::: tip One login, several connectors
The login session lasts 30 minutes. Adding a second connector within that
window shows an **Approve / Deny** page instead of the password prompt — the
hub already knows who you are, but it will not hand a code to a client you have
not confirmed.
:::

## Claude Code

```sh
claude mcp add -t http paperless https://mcp.example.net/paperless/mcp
claude mcp add -t http hub https://mcp.example.net/hub
```

Claude Code opens a browser for the OAuth flow on first use, the same way.

## ChatGPT

Enable Settings → **Security and login** → *Developer mode*, then go to
Settings → **Plugins** → *Browse plugins* and press **+**.

In the left column of the dialog: give the connector a *Name*, leave
*Connection* on **Server URL** and enter the endpoint **including its path**,
then set *Authentication* to **OAuth** and tick the risk acknowledgement.

::: warning The path is not optional
`https://mcp.example.net/` is not an MCP endpoint. ChatGPT falls back to
probing `/mcp`, and all you see is
`{"error":"invalid_token","error_description":"Missing Authorization header"}`.
Use `https://mcp.example.net/hub` or `https://mcp.example.net/<name>/mcp`.
:::

Open **Advanced OAuth settings** and fill in the fields under *OAuth endpoints*.
The hub supports both registration methods ChatGPT offers, so either works:
**CIMD** is what it picks by default and needs no registration URL, while
*Dynamic Client Registration (DCR)* stays greyed out until one is present in the
form. See [client registration](/guide/client-registration) for what the two do.

| Field | Value |
|---|---|
| Auth URL | `https://mcp.example.net/authorize` |
| Token URL | `https://mcp.example.net/token` |
| Registration URL | `https://mcp.example.net/register` (only for DCR) |
| Authorization server base | `https://mcp.example.net` (no trailing slash) |
| Resource | the connector URL, e.g. `https://mcp.example.net/hub` |

*Resource* has to be a canonical resource identifier — `/hub` or
`/<name>/mcp`, the same value the RFC 9728 document names. Anything else is
rejected with `invalid_target`.

Two settings stay untouched: leave *Base scopes* and *Default scopes* empty
(the hub advertises no `scopes_supported`, and requesting one fails with
`invalid_scope`), and leave **OIDC disabled** — the hub only mirrors its RFC
8414 document at the [OIDC discovery path](/reference/endpoints#discovery-documents),
it is not an OpenID Connect provider.

Press *Create*, and ChatGPT identifies itself, opens the hub's login page and
asks for the password. On the CIMD path the login page names the connector's
metadata document URL under *Identified by*; on the DCR path the hub logs a
`registered OAuth client` line instead. From then on the connector reconnects
on its own.

::: tip Sign in appears to do nothing?
On hubs older than 0.7.0 the interactive pages sent a `form-action 'self'`
CSP, which browsers also apply to the redirect that carries the code back to
the client. The password was accepted and the redirect silently dropped, so
the window just sat there. Upgrade the hub.
:::

## Codex CLI

```sh
codex mcp add hub \
  --url https://mcp.example.net/hub \
  --oauth-resource https://mcp.example.net/hub
```

Passing `--url` instead of a command selects streamable HTTP, which is the only
transport Codex will run an OAuth login against.

`--oauth-resource` is required here: the hub binds every token to one resource
(RFC 8707), and an authorization request without it is refused with
`invalid_target`. The value is the canonical identifier — `…/hub` or
`…/<name>/mcp`.

`codex mcp add` writes the entry to `~/.codex/config.toml` and starts the login
right away (*"Detected OAuth support. Starting OAuth flow…"*), so the browser
lands on the hub's password page. If it prints *"MCP server may or may not
require login"* instead, run `codex mcp login hub`. The result:

```toml
[mcp_servers.hub]
url = "https://mcp.example.net/hub"
oauth_resource = "https://mcp.example.net/hub"
```

Older Codex builds have no `--oauth-resource` flag — add that line by hand,
then `codex mcp login hub`.

Codex requests whatever scopes it discovers and retries without them if the
provider objects; since the hub advertises none, neither happens. Its callback
is a loopback URL on a port it picks per flow, which the hub accepts.

`codex mcp list` shows an *Auth* column, `codex mcp get hub` the full entry,
and `codex mcp logout hub` drops the stored credentials.

## Gemini CLI

```sh
gemini mcp add --transport http --scope user hub https://mcp.example.net/hub
```

`--transport http` matters: in Gemini's configuration `url` means SSE and
`httpUrl` means streamable HTTP, so without the flag the entry is written for a
transport the hub does not serve. `--scope user` puts it in
`~/.gemini/settings.json`; the default, `project`, writes `.gemini/settings.json`
in the current directory.

```json
{
  "mcpServers": {
    "hub": {
      "httpUrl": "https://mcp.example.net/hub"
    }
  }
}
```

Gemini compares resource identifiers strictly, so use exactly the URL the
path-scoped metadata names — `https://mcp.example.net/paperless/mcp`, not the
short `…/paperless` form, and `…/hub` for the aggregate.

OAuth is discovered from the hub's `401` challenge, so the `oauth` block with
`clientId`, `authorizationUrl` and `tokenUrl` stays out of the configuration.
If the flow does not start on its own, or a token has expired, run `/mcp auth
hub` inside the CLI; `/mcp auth` alone lists the servers waiting for a login.

Two knobs are worth knowing: `timeout` (600000 ms by default) bounds each
request, and `trust: true` has nothing to do with authenticating against the
hub — it only stops Gemini from asking you to confirm tool calls.

## Local clients over stdio

A client that only speaks stdio — Claude Desktop, Codex, anything that spawns a
local process — can use the hub without HTTPS, a reverse proxy or OAuth:

```json
{
  "mcpServers": {
    "hub": {
      "command": "npx",
      "args": ["-y", "@ni-c/mcp-hub", "--stdio"],
      "env": { "CONFIG_PATH": "/home/you/.config/mcp-hub/mcp.json" }
    }
  }
}
```

`--stdio` serves the same aggregate as `/hub`: the six meta-tools, the same
`mcp.json`, the same supervision and hot reload. Individual servers get no path
of their own here — everything goes through `call_tool`, which is the point:
one entry in the client's config instead of N, and six tool schemas in the
context instead of the sum of all of them. `CONFIG_PATH` defaults to `mcp.json`
in the working directory; a missing file starts an empty hub rather than
failing, so the client keeps running while you write one.

The [on-demand lifecycle](/guide/on-demand) applies here as well, and matters
more than it does behind HTTP: a hub spawned per client session would otherwise
start every configured server at every launch. Servers boot into `sleeping`
from the snapshot in `.mcp-hub/tool-cache.json` next to the config
(`TOOL_CACHE_PATH` moves it), and the first `call_tool` wakes the one it needs.

::: warning No authentication
stdio has no tokens and no login — the trust boundary is the local user
account, exactly as for any other stdio MCP server. Everything the child
servers can reach, the client can reach. The OAuth stack exists for the HTTP
endpoints, where the hub is reachable over the network.
:::

## Other clients

Anything that implements the MCP authorization spec works. The hub publishes
the standard discovery documents, so a client only needs the endpoint URL:

- `/.well-known/oauth-protected-resource[/<path>]` — RFC 9728, tells the client
  which authorization server to use, path-scoped so `/paperless/mcp` gets its
  own resource identifier
- `/.well-known/oauth-authorization-server[/<path>]` — RFC 8414 metadata for
  the hub's own authorization server, also served at
  `/.well-known/openid-configuration` for clients that probe there first

Clients that want the endpoints typed in rather than discovered will find every
path, with what guards it, under [HTTP endpoints](/reference/endpoints).

Obtaining a `client_id` is open, as the MCP specification intends — whether the
client points at a [metadata document it hosts
itself](/guide/client-registration#client-id-metadata-documents) or registers
dynamically at `/register`. Neither grants anything on its own: a client only
receives an authorization code after you have confirmed it, and only at the
redirect URI you confirmed.

## The approval flow

<figure class="hub-diagram">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="consent-title">
  <title id="consent-title">Decision flow when a client requests authorization</title>
  <defs>
    <marker id="arrow-consent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" />
    </marker>
  </defs>

  <rect class="node-accent" x="290" y="14" width="180" height="44" rx="9" />
  <text x="380" y="41" text-anchor="middle" class="label-mono">GET /authorize</text>

  <path class="edge" d="M380 58 L380 88" marker-end="url(#arrow-consent)" />

  <rect class="node" x="272" y="88" width="216" height="44" rx="9" />
  <text x="380" y="115" text-anchor="middle">Valid login session?</text>

  <path class="edge" d="M272 110 L150 110 L150 158" marker-end="url(#arrow-consent)" />
  <text x="205" y="102" text-anchor="middle" class="label-muted">no</text>
  <path class="edge" d="M488 110 L610 110 L610 158" marker-end="url(#arrow-consent)" />
  <text x="556" y="102" text-anchor="middle" class="label-muted">yes</text>

  <rect class="node" x="66" y="158" width="168" height="48" rx="9" />
  <text x="150" y="180" text-anchor="middle" class="label-title">Password page</text>
  <text x="150" y="197" text-anchor="middle" class="label-muted">10 tries / 15 min per IP</text>

  <rect class="node" x="520" y="158" width="180" height="48" rx="9" />
  <text x="610" y="180" text-anchor="middle">Client already</text>
  <text x="610" y="196" text-anchor="middle">approved?</text>

  <path class="edge" d="M150 206 L150 246" marker-end="url(#arrow-consent)" />
  <path class="edge" d="M520 182 L400 182 L400 246" marker-end="url(#arrow-consent)" />
  <text x="452" y="174" text-anchor="middle" class="label-muted">no</text>
  <path class="edge-accent" d="M700 182 L730 182 L730 292 L468 292" marker-end="url(#arrow-consent)" />
  <text x="730" y="172" text-anchor="middle" class="label-muted">yes</text>

  <rect class="node" x="66" y="246" width="168" height="46" rx="9" />
  <text x="150" y="268" text-anchor="middle" class="label-title">Correct password</text>
  <text x="150" y="284" text-anchor="middle" class="label-muted">counts as consent</text>

  <rect class="node" x="316" y="246" width="168" height="46" rx="9" />
  <text x="400" y="268" text-anchor="middle" class="label-title">Approve / Deny</text>
  <text x="400" y="284" text-anchor="middle" class="label-muted">CSRF-protected page</text>

  <path class="edge-accent" d="M234 269 L312 269" marker-end="url(#arrow-consent)" />
</svg>
<figcaption>A client is confirmed exactly once, bound to its client ID <em>and</em> the redirect URI it used.</figcaption>
</figure>

An approval records the client ID together with the redirect URI it was
approved for. A client that later asks for a different redirect target is
treated as new and needs confirming again. Loopback redirect URIs — the
`http://127.0.0.1:<port>/…` form desktop clients use — match regardless of
port, as the OAuth specification requires.

Denying sends the client away with `error=access_denied`.

## Token lifetimes

| | |
|---|---|
| Authorization code | 10 minutes, single use |
| Access token | **15 minutes**, opaque — a reference the hub can withdraw at any time |
| Refresh token | 30 days, rotated on every use |
| Login session cookie | 30 minutes, `HttpOnly`, `SameSite=Lax`, `__Host-` prefixed over HTTPS |

Refresh tokens rotate: each use issues a new one and retires the old. Replaying
a token that was already rotated away revokes the whole chain, on the
assumption that it leaked. A refresh can never widen scope beyond the original
grant.

## Resource-bound tokens

Every token is bound to the single resource the client asked for. A token
issued for `/paperless/mcp` cannot call `/hub`, `/health` or any other server's
path — `/health` counts as part of `/hub`, because it reports the same
fleet-wide view.

Clients discover the right resource identifier from the RFC 9728 document of
the endpoint they connect to, so this needs no client-side configuration. An
authorization request that names no resource at all is refused with
`invalid_target`.

::: warning Upgrading from 0.4 or earlier
Before 0.5.0 this had to be switched on with `RESOURCE_BOUND_TOKENS=true`, and
tokens issued without a resource reached every path. Those unbound tokens stop
working the moment binding is enforced, so **every connector authorizes once
more** after the upgrade.

If you need to postpone that, set `RESOURCE_BOUND_TOKENS=false`. It keeps the
old behaviour, logs a warning on every start, and is meant to be removed again
— not to be left in place.
:::

## Revoking a client

Use the offline admin command; it is covered on the
[deployment page](/guide/deployment#managing-clients).

## Notification support

Push traffic is not delivered to clients on either MCP revision: `listChanged`
notifications and resource subscriptions do not travel outward. Tool, resource
and prompt request/response traffic works in full.

Internally the hub does follow `tools/list_changed` from its children, so the
`/hub` tool cache stays current even though clients are not notified.

**Elicitation is the exception, and it is not a notification.** On
`2026-07-28` a server that needs to ask the user something returns the question
instead of pushing it, so it reaches you through both `/hub` and
`/<name>/mcp` — see [Elicitation](/guide/elicitation). A client on
`2025-11-25` is not offered it over HTTP, because there the question would be a
push and would be dropped.
