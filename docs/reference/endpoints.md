# HTTP endpoints

Everything mcp-hub serves, and what guards it.

## MCP endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/<name>` | Bearer | Streamable HTTP endpoint of one server (canonicalized to `/<name>/mcp`) |
| `/<name>/mcp` | Bearer | same, canonical form |
| `/hub` | Bearer | aggregate endpoint exposing the [six meta-tools](/reference/hub-tools) |

`<name>` is a key from `mcpServers`. Both routes accept the HTTP methods the
Streamable HTTP transport uses.

A server that is not `up` answers `503` with a JSON-RPC error naming its state:

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32000, "message": "Server \"paperless\" is starting" },
  "id": null
}
```

## Status

| Path | Auth | Purpose |
|---|---|---|
| `/livez` | none | process liveness; always `200 {"status":"ok"}` while the process runs |
| `/health` | Bearer for `/hub` | per-server state; `200` when every server is `up` or `sleeping`, `503` otherwise |

`/health` reports the same fleet-wide view as the `/hub` aggregate, so it takes
the same resource: a token issued for one server's path gets `401` here.

`/livez` is what the image `HEALTHCHECK` calls, and it is the endpoint external
monitoring should poll. A degraded child does **not** make the container
unhealthy.

`/health` response:

```json
{
  "status": "degraded",
  "servers": {
    "paperless":     { "state": "up",   "kind": "stdio",  "restarts": 0, "tools": 14, "hub": true },
    "internal-only": { "state": "down", "kind": "remote", "restarts": 2, "tools": 0,  "hub": false },
    "scraper":           { "state": "up",   "kind": "docker", "restarts": 0, "tools": 84, "hub": true,
                       "image": "scraper-mcp@sha256:…", "container": "mcp-sandbox-scraper" }
  }
}
```

`state` is one of `starting`, `up`, `down`, `sleeping`, `unauthorized`. `kind` is `stdio`,
`remote`, `docker` or `socket`. `restarts` counts supervisor restarts since
boot. `hub` says whether the server appears in the `/hub` aggregate. A
`sleeping` [on-demand server](/guide/on-demand) counts as healthy — it is
resting by design, and its cached `tools` count stays visible. `unauthorized`
is a remote server whose [upstream OAuth](/guide/configuration#upstreams-that-speak-oauth)
needs attention; it is counted as degraded and, unlike `down`, is not retried
until somebody acts. A
[sandboxed server](/guide/sandboxing) also reports the `image` and `container`
it runs as — a local tag and a name, not credentials, and the difference
between "scraper is down" and something you can act on.


A server with `allowTools` or `denyTools` also carries a `toolFilter` object —
`exposed`, `hidden` and any `unmatched` entries. It is absent for every server
without a filter, and `tools` keeps its meaning: the number a client can see.

## OAuth 2.1

| Path | Auth | Purpose |
|---|---|---|
| `/authorize` | session / password | authorization endpoint (PKCE required); accepts an https URL as `client_id` |
| `/token` | client secret, `private_key_jwt` or none | token and refresh endpoint |
| `/register` | none | dynamic client registration (RFC 7591); `404` when disabled |
| `/register/<client_id>` | `registration_access_token` | the client's own registration (RFC 7592): `GET` to read, `PUT` to change, `DELETE` to remove it; `404` when dynamic registration is disabled |
| `/upstream/callback` | signed `state` + hub session | where an upstream sends the browser back after an `upstream login`; single use |
| `/.well-known/mcp-hub-client/<id>.json` | none | the hub's own client metadata document, one per `oauth.mode: "cimd"` upstream; `404` for an identifier nobody publishes |
| `/revoke` | client credentials | token revocation (RFC 7009) |
| `/login` | — | password form; a correct password approves the requesting client |
| `/consent` | session + CSRF token | Approve / Deny page for a client not yet confirmed |

Auth responses carry `Cache-Control: no-store`. The interactive pages deny
framing and carry a restrictive CSP.

A `client_id` that is an https URL with a path is treated as a [Client ID
Metadata Document](/guide/client-registration#client-id-metadata-documents) and
fetched from the client; anything else is looked up as a dynamically registered
client. Which mechanisms are accepted is set with
[`CLIENT_REGISTRATION`](/reference/environment).

Rate limits are listed on the [security page](/guide/security#rate-limits).

## Discovery documents

| Path | Auth | Purpose |
|---|---|---|
| `/.well-known/oauth-authorization-server` | none | RFC 8414 authorization-server metadata |
| `/.well-known/oauth-authorization-server/<suffix>` | none | same document, path-inserted form |
| `/.well-known/oauth-protected-resource` | none | RFC 9728 protected-resource metadata |
| `/.well-known/oauth-protected-resource/<suffix>` | none | path-scoped variant |
| `/.well-known/openid-configuration` | none | alias serving the same RFC 8414 document |
| `/.well-known/openid-configuration/<suffix>` | none | same alias, path-inserted form |

The authorization-server document advertises both registration mechanisms:

```json
{
  "client_id_metadata_document_supported": true,
  "registration_endpoint": "https://mcp.example.net/register",
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none", "private_key_jwt"],
  "token_endpoint_auth_signing_alg_values_supported": ["RS256", "…", "EdDSA"]
}
```

`client_id_metadata_document_supported` is what makes a spec-compliant client
prefer CIMD; `registration_endpoint` is absent when dynamic registration is
turned off, and the CIMD fields are absent when metadata documents are.

The hub is **not** an OpenID Connect provider — there is no `userinfo`
endpoint and no `id_token`. The alias exists because several clients, ChatGPT
among them, probe the OIDC path before the RFC 8414 one, and the document
answers every field they read there. Enabling a client's OIDC option on top of
it does not work.

The path-scoped resource document is what makes
[resource-bound tokens](/guide/clients#resource-bound-tokens) work without
client configuration. A client connecting to `/paperless/mcp` looks up
`/.well-known/oauth-protected-resource/paperless/mcp` and gets:

```json
{
  "resource": "https://mcp.example.net/paperless/mcp",
  "authorization_servers": ["https://mcp.example.net"],
  "bearer_methods_supported": ["header"],
  "resource_name": "mcp-hub"
}
```

It then requests a token for exactly that resource. One authorization server
covers every resource the hub exposes.

## Reserved names

These cannot be used as server names, because the hub serves them itself:

`mcp` · `hub` · `authorize` · `token` · `register` · `login` · `consent` ·
`health` · `livez` · `revoke` · `upstream` · `.well-known`

The check is case-insensitive and happens when the config is parsed.
