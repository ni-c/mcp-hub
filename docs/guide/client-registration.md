# Client registration

Before a client can ask you for an authorization code it needs a `client_id`.
mcp-hub accepts two ways of getting one, and prefers the newer of them.

**Client ID Metadata Documents (CIMD)** are the mechanism the MCP specification
now recommends. The client publishes a JSON document at a stable HTTPS URL and
uses that URL as its `client_id`; the hub fetches the document and reads the
client's name and redirect URIs out of it. Nothing is registered, nothing is
stored, nothing expires.

**Dynamic client registration (DCR, [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591))**
is the older mechanism: the client `POST`s its metadata to `/register` and the
hub hands back a generated `client_id`. The MCP specification deprecated it in
the 2026-07-28 revision, but every client written against an earlier revision —
Claude Code, Cursor, Codex CLI — still uses it, so the hub keeps it on.

A spec-compliant client picks between them on its own, using the priority the
[specification defines](https://modelcontextprotocol.io/specification/draft/basic/authorization/client-registration):
credentials it was pre-configured with, then CIMD, then DCR. The hub advertises
both, so a client that supports CIMD uses CIMD and a client that does not falls
back without anyone having to configure anything.

## What the hub advertises

```sh
curl -s https://mcp.example.net/.well-known/oauth-authorization-server | jq
```

```json
{
  "issuer": "https://mcp.example.net/",
  "authorization_endpoint": "https://mcp.example.net/authorize",
  "token_endpoint": "https://mcp.example.net/token",
  "registration_endpoint": "https://mcp.example.net/register",
  "client_id_metadata_document_supported": true,
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none", "private_key_jwt"],
  "grant_types_supported": ["authorization_code", "refresh_token"]
}
```

`client_id_metadata_document_supported` is the flag clients key on.
`registration_endpoint` disappears when you turn DCR off; see
[below](#turning-dynamic-registration-off).

## Client ID Metadata Documents

### The document

A client hosts something like this at an HTTPS URL it controls:

```json
{
  "client_id": "https://app.example.com/oauth/client-metadata.json",
  "client_name": "Example MCP Client",
  "client_uri": "https://app.example.com",
  "redirect_uris": [
    "http://127.0.0.1:3000/callback",
    "http://localhost:3000/callback"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

and then simply uses that URL wherever a `client_id` goes:

```
GET /authorize
  ?client_id=https://app.example.com/oauth/client-metadata.json
  &redirect_uri=http://127.0.0.1:3000/callback
  &response_type=code&code_challenge=…&code_challenge_method=S256
  &resource=https://mcp.example.net/hub
```

### What the hub checks

**The URL has to look like an identifier.** `https` scheme, a path component, no
fragment, no credentials in the URL and no `.`/`..` segments — checked against
the string the client sent, so a percent-encoded `%2e%2e` does not slip past.

**The document has to vouch for itself.** Its `client_id` field must equal the
URL it was fetched from, compared as a plain string. Without that check any
origin could serve a document claiming to be a different client.

**Required fields.** `client_id`, `client_name` and a non-empty `redirect_uris`
array. Every redirect URI must be `https` or a loopback address — the same rule
the hub applies to registered clients.

**No shared secrets.** A document carrying a `client_secret`, or declaring
`client_secret_post`/`client_secret_basic`, is refused: a document anyone can
read is not a place to keep a secret. Only `none` and `private_key_jwt` are
accepted, and `private_key_jwt` needs a `jwks` or `jwks_uri` alongside it.

**The redirect URI still has to match.** The one in the authorization request
must appear in the document's `redirect_uris`. Loopback redirect URIs may differ
in port ([RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)),
because native clients take whatever port the OS gives them; everything else is
an exact match.

Every rejection returns a bare `invalid_client` with no explanation. The reason
is written to the hub's log instead, so a caller cannot map out the policy by
probing. If a client cannot connect, read the log:

```
mcp-hub: refused client metadata document https://app.example.com/oauth/client-metadata.json: client_id does not match the document URL
```

### Fetching the document safely

The `client_id` is a URL an unauthenticated caller chose, so the fetch is
treated as hostile:

| | |
|---|---|
| Scheme | `https` only |
| Redirects | never followed |
| Addresses | private, loopback, link-local and CGNAT ranges are refused, after DNS resolution; the IPv6 forms that carry an IPv4 address (NAT64, 6to4) are refused too |
| Connection | pinned to the address that was checked, so the name is never resolved a second time |
| Size | 5 kB, enforced while reading and against a declared `Content-Length` |
| Timeout | 5 seconds |
| Content type | `application/json` or a `+json` suffix |
| Caching | `Cache-Control: max-age`, clamped to 1 minute – 24 hours, 1 hour by default |

Pinning is what closes the gap between the check and the request. Resolving the
name, approving the answer and then handing the *name* to an HTTP client leaves
it free to resolve again — and a zone with a one-second TTL can answer with a
public address the first time and `169.254.169.254` the second. The address that
was approved is therefore the address the socket connects to, while the
certificate is still validated against the hostname.

Concurrent lookups of the same `client_id` collapse into a single request, and a
rejected `client_id` is remembered for 30 seconds. Because the query string is
part of the identifier, `…/c.json?n=1` and `…/c.json?n=2` are different clients
pointing at the same server, so per-URL memory alone would not bound how often
one host is contacted: an origin that fails ten times within 30 seconds is left
alone until that window passes. Neither an impatient client nor a hostile one
can turn the hub into an amplifier pointed at someone else.

### Consent still decides

Accepting a metadata document is not the same as trusting the client. Exactly as
with dynamic registration, a document grants nothing on its own: the hub shows
you who is asking and issues a code only after you approve.

The authorization page names the document URL under **Identified by**. That URL
is the one part of the client's identity that cannot be invented — the name and
logo in the document are self-declared, the origin serving it is not. When every
redirect URI points at loopback, the page says so outright, because a code going
to `http://127.0.0.1:…` could be collected by any program on that machine.

Once approved, the approval is remembered under the document URL, so
re-authorizing later is silent. Because the URL is stable, a client that is
reinstalled or moved to another machine is still recognised as the same client.

### `private_key_jwt`

A client that wants to be confidential publishes its public keys and signs a
JWT at the token endpoint instead of sending a secret. ChatGPT's connectors take
this path.

```json
{
  "client_id": "https://app.example.com/oauth/client-metadata.json",
  "client_name": "Example MCP Client",
  "redirect_uris": ["https://app.example.com/callback"],
  "token_endpoint_auth_method": "private_key_jwt",
  "jwks_uri": "https://app.example.com/oauth/jwks.json"
}
```

The token request then carries the assertion instead of a secret:

```
grant_type=authorization_code
&code=…&code_verifier=…
&client_id=https://app.example.com/oauth/client-metadata.json
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion=eyJhbGciOiJFUzI1NiIs…
```

The hub verifies the assertion against the keys in the document — an inline
`jwks` when present, otherwise `jwks_uri`, fetched through the same guards as
the document itself, under a 64 kB cap of its own. It requires `iss` and `sub`
to be the client ID, `aud` to be the token endpoint or the issuer, a `jti`, and
an `exp` no more than five minutes out. A `jti` is accepted once; a replay is
refused. Signature algorithms are RS/PS/ES 256/384/512 and EdDSA.

A client that declares `private_key_jwt` **must** present an assertion. Omitting
it is not a way to be treated as a public client: a metadata-document client
holds no `client_secret`, so without this rule a leaked refresh token or
authorization code would be redeemable by anyone who simply left the
`client_assertion` parameter out — which is precisely what the private key is
there to prevent.

## Dynamic client registration

Unchanged from earlier versions and on by default. `POST /register` with client
metadata returns a generated `client_id`, the registration is written to the
state file, and — as with CIMD — it grants nothing until you approve the client.
Registrations do not stay forever; the rules are in
[Registrations do not accumulate](#registrations-do-not-accumulate) below.

Two deliberate deviations keep ChatGPT working: issued secrets never expire, and
a public client (`token_endpoint_auth_method: "none"`) receives a `client_secret`
in the registration response that is never stored and never required.

Redirect URIs are held to the same rule as a metadata document's, with one
addition for native clients:

| | |
|---|---|
| `https://app.example.com/cb` | accepted |
| `http://127.0.0.1:51000/cb`, `http://localhost/cb` | accepted — the code never leaves the machine |
| `com.example.app:/cb`, `myapp://cb` | accepted for dynamic registration only ([RFC 8252 §7.1](https://www.rfc-editor.org/rfc/rfc8252#section-7.1)) |
| `http://app.example.com/cb` | **refused** — the code would travel in the clear |
| `javascript:`, `data:`, `file:`, `blob:` | **refused** |

A refused registration answers `400 invalid_client_metadata`.

### Registrations do not accumulate

Anyone may register, so registrations are on a clock and under a ceiling:

| | Default | What happens |
|---|---|---|
| `DCR_PENDING_TTL_HOURS` | 24 hours | A registration that was never approved is removed. Opening the authorization page counts as use and restarts the window, so a login where the user takes their time is not cut short. |
| `DCR_INACTIVE_DAYS` | 90 days | An approved registration nobody has used is removed together with its approval and refresh tokens. Use means an authorization or a token exchange. |
| `DCR_MAX_CLIENTS` | 500 | The ceiling. Reaching it evicts the oldest never-approved registrations first. |

If the ceiling is reached and *every* registration under it has been approved,
a new registration is refused with `400 too_many_requests` rather than a working
connector being dropped — otherwise anyone able to register at will could push a
specific connector out.

The sweep runs at startup and every fifteen minutes. Upgrading is safe: clients
in a state file written before this existed are given a fresh clock rather than
being read as idle since the day they registered.

None of this touches Client ID Metadata Document clients. They are never stored,
so there is nothing to expire — their approval stays until you revoke it.

### Managing a registration (RFC 7592)

The registration response carries two extra fields:

```json
{
  "client_id": "mV5xQ2sJk1Tz…",
  "registration_access_token": "…",
  "registration_client_uri": "https://mcp.example.net/register/mV5xQ2sJk1Tz…"
}
```

The token is shown exactly once — only its hash is stored, so it cannot be
recovered from the state file. With it the client manages its own registration:

```
GET    /register/<client_id>     read it back
PUT    /register/<client_id>     replace the metadata
DELETE /register/<client_id>     remove it
```

all with `Authorization: Bearer <registration_access_token>`. `DELETE` answers
`204` and takes the approval and every refresh token with it; the `client_id`
stops working immediately.

`PUT` must repeat the `client_id` in the body, cannot change `client_secret`,
and holds the new redirect URIs to the same rule as registration. **Changing the
redirect URIs withdraws the approval**: consent was given for a destination, and
a client does not get to move that destination afterwards and keep it. The next
authorization shows the consent page again. Changing anything else — a name, a
logo — leaves the approval in place.

A wrong token and a `client_id` that does not exist get the same `401`, so this
cannot be used to find out which clients are registered.

::: tip Lost the token?
There is no recovery path by design. Ask the operator to run
`mcp-hub-admin clients delete <client-id>` and register again.
:::

## Clients that can do neither

Some clients support no registration mechanism at all and expect a `client_id`
and secret to be configured by hand. For those, issue one:

```sh
mcp-hub-admin clients add --name "Legacy integration" --redirect-uri https://app.example/callback
```

The secret is printed once. `--public` creates a client without one. The
redirect URI is held to the same rule as everywhere else: `https`, a loopback
address, or a private-use scheme for a native client.

Such a client differs from a self-registered one in two ways. It counts as
approved for the redirect URI you named — you created it deliberately, so being
sent to a browser to confirm your own typing would be theatre — and it is exempt
from every lifecycle rule above. Nothing removes it but
`mcp-hub-admin clients delete`.

If the client can only send a bearer token and cannot do OAuth at all, an
[API token](/guide/clients#api-tokens) is the smaller tool for the job.

## Admission policy

By default every valid HTTPS URL is admitted and the consent page is what
decides. That matches how DCR already works — anyone may ask, only you may
approve.

If you want a stricter deployment, name the origins you accept:

```
CIMD_ALLOWED_ORIGINS=https://chatgpt.com,https://vscode.dev
```

A `client_id` from any other origin is refused before the hub makes a request.
Note that the *path* is not something you can pin: ChatGPT mints a fresh
per-connector URL such as `https://chatgpt.com/oauth/<random>/client.json`, so
only the origin is stable.

## Turning dynamic registration off

`CLIENT_REGISTRATION` names the mechanisms you accept, as a comma-separated
list. The default is both:

```
CLIENT_REGISTRATION=cimd,dcr    # default
CLIENT_REGISTRATION=cimd        # metadata documents only
CLIENT_REGISTRATION=dcr         # dynamic registration only
```

With `dcr` removed, `registration_endpoint` disappears from the discovery
document and `/register` answers `404`. Spec-compliant clients then choose CIMD
on their own. Clients that only speak DCR can no longer connect at all, so check
[client compatibility](/guide/client-compatibility) before you switch.

With `cimd` removed, `client_id_metadata_document_supported` disappears and a
URL `client_id` is treated as an unknown client — no document is ever fetched.

## Local development

Metadata documents are fetched over `https` from public addresses only, which
makes a hub and a client on the same laptop impossible to test. For that case
only:

```
CIMD_ALLOW_PRIVATE_ADDRESSES=true
```

The hub logs a warning while this is on. Do not use it in production: it is what
otherwise stops a `client_id` from being aimed at your internal network or a
cloud metadata endpoint.

## Seeing who got in

```sh
docker exec -it mcp-hub mcp-hub-admin clients list
```

```json
[
  {
    "clientId": "https://app.example.com/oauth/client-metadata.json",
    "clientName": "Example MCP Client",
    "via": "cimd",
    "registeredRedirectUris": [],
    "approvedRedirectUris": ["http://127.0.0.1:3000/callback"],
    "approvedAt": "2026-08-25T09:12:44.000Z"
  }
]
```

`via` says which mechanism the client came in through. A CIMD client has no
stored registration — the document is fetched fresh — so
`registeredRedirectUris` is empty and the approval is the whole record.
Revoking works the same for both:

```sh
mcp-hub-admin clients revoke 'https://app.example.com/oauth/client-metadata.json'
```

`revoke` withdraws access but keeps the registration, so the client can go
through consent again. To remove it outright — the equivalent of the client
deleting itself — use `delete`:

```sh
mcp-hub-admin clients delete mV5xQ2sJk1Tz
```

`prune` applies the lifecycle rules on demand instead of waiting for the next
sweep. It reads the same `DCR_*` variables the hub does, so run it in the hub's
environment (`docker exec` does that for you), and check first with
`--dry-run`:

```sh
mcp-hub-admin clients prune --dry-run
```

```json
{
  "dryRun": true,
  "limits": { "maxClients": 500, "pendingTtlHours": 24, "inactiveDays": 90 },
  "neverApproved": [{ "clientId": "mV5xQ2sJk1Tz", "clientName": "Some Editor" }],
  "unused": []
}
```

## Next

- [Connecting clients](/guide/clients) — the per-client walkthroughs
- [Client compatibility](/guide/client-compatibility) — what each product supports
- [Security](/guide/security) — the trust model around all of this
