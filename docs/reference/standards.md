# Standards

What mcp-hub implements, in which direction, and where the limits are.

Two directions matter, and they are genuinely different problems. **Inbound** is
mcp-hub as an authorization server and resource server for the MCP clients that
connect to it. **Outbound** is mcp-hub as an OAuth client toward the remote MCP
servers it connects to on your behalf. Most gateways do one of the two.

## Getting a client identity

The same four ways in and out — with one gap in each direction, named below.

| | Inbound (a client → the hub) | Outbound (the hub → an upstream) |
|---|---|---|
| **Operator-issued credentials** | `mcp-hub-admin clients add` issues a `client_id` and secret by hand | `oauth.mode: "static"` with a `clientId` the upstream gave you |
| **Dynamic registration** ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) | `POST /register`, on by default | `oauth.mode: "dcr"` |
| **Registration management** ([RFC 7592](https://www.rfc-editor.org/rfc/rfc7592)) | `GET`/`PUT`/`DELETE /register/<client_id>` | the hub deletes its own registration on `upstream logout` |
| **Client ID Metadata Documents** | a client uses its document URL as `client_id` | `oauth.mode: "cimd"`, one document per upstream |
| **Bearer token, no OAuth** | [API tokens](/guide/clients#api-tokens) minted by the operator | a static `Authorization` header |

CIMD is
[`draft-ietf-oauth-client-id-metadata-document-00`](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00),
the mechanism the MCP specification prefers over dynamic registration.

## Proving that identity

| | Inbound | Outbound |
|---|---|---|
| `client_secret_post` | ✅ | ✅ |
| `client_secret_basic` | ❌ — credentials are read from the form body only | ✅ |
| `none` (public client) | ✅ | ✅ |
| `private_key_jwt` ([RFC 7523](https://www.rfc-editor.org/rfc/rfc7523)) | ✅ **for metadata-document clients only** | ✅ via `oauth.clientAuth` |

Both directions sign and verify RS/PS/ES 256/384/512 and EdDSA. Outbound, the
hub signs with an Ed25519 key of its own at `<DATA_PATH>/upstream-key.pem` —
deliberately not the key that signs the access tokens it issues — and publishes
the public half in the document or registration the upstream reads.

## Grants

| | Inbound | Outbound |
|---|---|---|
| `authorization_code` + [PKCE](https://www.rfc-editor.org/rfc/rfc7636) | ✅ **S256 required**, `plain` rejected | ✅ S256 |
| `refresh_token` | ✅ rotating, with reuse detection | ✅ serialized, single-flight |
| `client_credentials` | ❌ | ✅ |

Inbound refresh tokens rotate on every use and are grouped into families:
replaying a retired token revokes the whole family, because a replay means two
parties hold one chain. Outbound, refresh is deliberately taken away from the
SDK and serialized per upstream — parallel requests that each hit a `401` would
otherwise each spend the same rotating token, which an upstream that detects
reuse treats exactly as above.

## Discovery and binding

| Standard | Inbound | Outbound |
|---|---|---|
| [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) authorization server metadata | ✅ served, incl. the path-inserted form | ✅ consumed |
| [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) protected resource metadata | ✅ served, incl. path-scoped variants | ✅ consumed, to find the upstream's authorization server |
| [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707) resource indicators | ✅ **enforced by default** | ✅ sent when the upstream publishes RFC 9728 |
| [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) native apps | ✅ loopback redirects, port-flexible | n/a |
| [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) revocation | ⚠️ refresh tokens only — see below | ✅ best effort on `upstream logout` |

Resource indicators are the reason a token issued for one server does not reach
another. Every access token carries the resource as its audience, and every
request is checked against the path it arrived on.

`/.well-known/openid-configuration` is served as a byte-identical **alias** of
the RFC 8414 document, because several clients probe it first. That is all it
is: there is no ID token, no `userinfo`, no OIDC claims. Do not enable a
client's "OpenID Connect" option against it.

## Not implemented

Named explicitly, so you do not have to find out by trying:

| | |
|---|---|
| **Access-token revocation** | `/revoke` accepts an access token and does nothing with it. Only refresh tokens are revoked there. To kill live access tokens, use `mcp-hub-admin clients revoke`, which sets a marker the verifier checks. |
| **`client_credentials` inbound** | The hub issues tokens to a person who approved a client, not to a machine identity. Use an [API token](/guide/clients#api-tokens) for that. |
| **Device authorization grant** ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) | Neither direction. |
| **`private_key_jwt` for dynamically registered clients** | Inbound it is accepted only from metadata-document clients. A DCR client uses its secret. |
| **DPoP** ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)), **mTLS** ([RFC 8705](https://www.rfc-editor.org/rfc/rfc8705)), **PAR** ([RFC 9126](https://www.rfc-editor.org/rfc/rfc9126)), **token introspection** ([RFC 7662](https://www.rfc-editor.org/rfc/rfc7662)), **token exchange** ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)), `client_secret_jwt` | None of them, in either direction. |
| **A published JWKS for the hub's own tokens** | Access tokens are EdDSA-signed and verified by the hub alone; there is no endpoint for a third party to verify them. |
| **Scopes as an authorization boundary** | Scopes are carried through but nothing is enforced on them. Authorization is by resource, not by scope. |
| **Users, roles, audit trails** | One shared password, no per-user identity. Every token's subject is the same. See [what the hub does not protect against](/guide/security#what-the-hub-does-not-protect-against). |
| **Per-user upstream tokens** | An upstream credential belongs to the deployment, not to the client that triggered the call. The hub does not act on behalf of individual users. |

## Transport and protocol

Streamable HTTP, stateless — no session state to leak — with SSE accepted for
upstreams that only speak that. Bearer tokens are read from the `Authorization`
header only; there is no query-parameter or form-body form.

The hub speaks **both** MCP revisions on every endpoint, and the client picks:

| Revision | How it is chosen | Where |
|---|---|---|
| **`2026-07-28`** | `server/discover` | `/hub`, `/<name>/mcp`, `mcp-hub-stdio` |
| **`2025-11-25`** | `initialize` | the same three |

Which one you are on is a wire detail. The rule the hub holds itself to is that
a client cannot tell from the answers: same tools, same names, same endpoint.

### What is carried, per revision

Every row here has a test, and the ones that say **no** say so because there is
no test that could pass — not because the detail was left out of the table. The
hub has twice announced something it did not deliver (`listChanged`,
`resources.subscribe`), and both cost more to find than they would have cost to
admit.

| Traffic | `2026-07-28` | `2025-11-25` |
|---|---|---|
| `tools/list`, `tools/call` | carried | carried |
| `resources/list`, `resources/templates/list`, `resources/read` | carried | carried |
| `prompts/list`, `prompts/get` | carried | carried |
| `completion/complete` | carried | carried |
| **Elicitation** — a child asking the person a question | **carried both ways** | not offered |
| Embedded `sampling/createMessage` or `roots/list` in a child's question | dropped, and named in the log | — |
| **`subscriptions/listen`** — a child's changes reaching a client | **carried** | not offered |
| `listChanged` notifications (tools, prompts, resources) | delivered on a subscription | not advertised, not delivered |
| `notifications/resources/updated` | delivered on a subscription | not advertised, not delivered |
| `resources/subscribe` | removed from the revision | not advertised, refused |
| `logging/setLevel`, `notifications/message` | not advertised, no handler | not advertised, no handler |

**Subscriptions are the second row worth reading twice**, for the same reason
as the first. `subscriptions/listen` is a long-lived stream, which sounds like
the one thing a stateless gateway cannot hold — but the state is the open HTTP
response, not a session table. When the socket goes, so does the subscription,
and nothing is left behind to leak. That is why this could be built without
giving up the property the rest of the design rests on. See
[Subscriptions](/guide/subscriptions).

To a `2025-11-25` client the hub offers none of it. That revision delivers
changes unsolicited on a channel the stateless transport does not keep, and
`resources/subscribe` needs the hub to remember who asked for what — so rather
than announce a `listChanged` whose notification would never arrive, the hub
stays quiet. The hub announced exactly that for a long time and it was a lie;
the row above is what it says now.

`logging` is the third. `logging/setLevel` never had a handler on either era, so
a client that believed the advertisement got a `-32601` at call time. On
`2026-07-28` the level is per-request `_meta` and there is no RPC left to
implement; carrying `notifications/message` is separate work. Until it exists
the capability is not offered.

**Elicitation is the row worth reading twice.** It is what
[`smtp-mcp`](/guide/elicitation) and `imap-mcp` use to put a question in front
of a person before they send or delete something, and behind a gateway it used
to have nowhere to go. On `2026-07-28` it does: the question is a *result*, the
call ends, the person decides, and the client retries with the answer. Nothing
is held open, which is exactly why a stateless hub can carry it. See
[Elicitation](/guide/elicitation).

To a `2025-11-25` client over HTTP the hub does not offer it at all. That
revision delivers a question as a server-initiated request, and a stateless hub
has no channel for one — so rather than announce a capability whose answer
would be dropped, the hub stays quiet and the child takes its own fallback.
That is the same rule as the two rows above it, applied before the mistake
instead of after.

The authorization behaviour follows the specification revision that made
metadata documents the preferred registration mechanism and deprecated dynamic
registration — which the hub still serves, because most clients still need it.

## Next

- [Subscriptions](/guide/subscriptions) — what a client can watch, and what a nap costs
- [How clients register](/guide/client-registration) — the inbound side in detail
- [Upstreams that speak OAuth](/guide/configuration#upstreams-that-speak-oauth) — the outbound side
- [Security](/guide/security) — the trust model around both
