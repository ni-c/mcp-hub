# Security

mcp-hub is exposed to the internet by design, so its security properties are
part of its interface. This page describes the trust model, the controls that
exist, and the deployment choices that are your responsibility.

The canonical policy lives in
[SECURITY.md](https://github.com/ni-c/mcp-hub/blob/main/SECURITY.md) in the
repository.

## Reporting a vulnerability

Use [GitHub private vulnerability
reporting](https://github.com/ni-c/mcp-hub/security/advisories/new). Please do
not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

Only the latest release and the current `main` branch receive security fixes.

## Trust model

**mcp-hub is an authorization gateway, not a sandbox.**

Every stdio server configured in the hub container runs as the same
operating-system user as the hub itself. It can therefore read the hub's
mounted files — including `/data/jwt-key.pem` and `/data/state.json` — inspect
the hub process, and reach whatever the container's network policy allows.

The consequences are worth stating plainly:

- A malicious or compromised stdio package in your `mcp.json` can mint its own
  access tokens and reach every other server in the hub.
- Only run stdio packages you have reviewed and trust.
- Servers with a different trust level belong in **separate containers or
  hosts**, with their own filesystem, credentials and network policy.

For those, [sandboxing](/guide/sandboxing) is the direct route: `type: "docker"`
has the hub create the container and speak stdio to it over the Docker API,
`type: "unix"` connects to a container you started yourself. Both keep the
protocol on a byte stream, so the sandboxed server needs no HTTP listener, no
bearer token and no bridge process in its image — and with a Unix socket it can
run with `network_mode: none`, which an HTTP upstream can never do. Connecting
a server that already speaks HTTP as a
[remote upstream](/guide/configuration#remote-servers) remains equally valid;
it has no access to the hub's process or files either.

**The hub never gets the Docker socket.** `type: "docker"` is served by a
separate `mcp-hub-docker-proxy` container, which holds the daemon socket and
allows only the container operations `mcp.json` describes — no privileged
containers, no host mounts, no foreign images, whatever the hub asks for. The
daemon API is root-equivalent, and the hub is the part exposed to the internet;
those two must not meet. See [the policy proxy](/guide/sandboxing#the-policy-proxy).

A sandboxed server's credentials can be kept out of the hub entirely with
`secretsFrom`: the proxy holds the env file and adds the variables after it has
validated the request, so they never enter the process whose children can read
`/proc/1/environ`.

Avoid `npx -y`, unversioned `uvx`, mutable Git branches and any other runtime
download. Install reviewed, exactly-versioned server packages while building a
[custom image](/guide/deployment#custom-image), scan that image, and keep the
runtime root filesystem read-only.

## Deployment checklist

- [ ] TLS terminated at a trusted reverse proxy; `EXTERNAL_URL` set to the
      exact public HTTPS origin
- [ ] `TRUSTED_PROXIES` set to proxy addresses that **overwrite** forwarded
      headers ([details below](#trusted-proxies))
- [ ] `PASSWORD_HASH` rather than a plain-text `PASSWORD`
- [ ] `/data` on a persistent, private volume
- [ ] `RESOURCE_BOUND_TOKENS` left at its default (`true`) — the migration
      mode is not still switched off
- [ ] `CIMD_ALLOWED_ORIGINS` set to the origins you actually expect, unless you
      deliberately want any HTTPS origin to be able to ask for consent
- [ ] `CIMD_ALLOW_PRIVATE_ADDRESSES` **not** set — it is a local-development
      switch and turns off the guard that keeps a `client_id` from being aimed
      at your internal network
- [ ] The example's non-root user, dropped capabilities, read-only root
      filesystem, `pids_limit`, memory limit and `no-new-privileges`
- [ ] `/data/jwt-key.pem`, `/data/state.json`, the MCP config and every
      referenced environment variable treated as secrets — with `state.json`
      handled as **third-party** credentials once any upstream uses OAuth
- [ ] Outbound network access restricted to what the configured servers need
- [ ] `/var/run/docker.sock` mounted **only** into `mcp-hub-docker-proxy`, never
      into the hub, and both images on the same version
- [ ] Sandbox secret files (`secretsFrom`) `chmod 640` and mounted into the
      proxy only

## Authentication and authorization

**One password.** There are no user accounts. Anyone who knows the password can
approve a client and reach every server the hub exposes. Use a strong one and
store the bcrypt hash, not the plain text.

**Identifying yourself is open, approval is not.** Both ways of obtaining a
`client_id` — a [Client ID Metadata
Document](/guide/client-registration#client-id-metadata-documents) or
[dynamic registration](/guide/client-registration#dynamic-client-registration) —
are unauthenticated, as the MCP specification intends. Neither grants anything:
a client receives an authorization code only after you confirmed it, and only at
the redirect URI you confirmed. Metadata documents are not stored at all.

**Registrations do not accumulate.** A dynamic registration that is never
approved is dropped after a day, an approved one nobody has used after 90 days —
together with its approval and refresh tokens — and the store holds at most 500.
When the ceiling is reached the oldest never-approved registrations are evicted
first; if every one of them has been approved, the new registration is refused
instead, so nobody can push a working connector out by registering repeatedly.
A client can also remove its own registration
([RFC 7592](/guide/client-registration#managing-a-registration-rfc-7592)) with
the credential it was issued at registration, of which only a hash is stored.
Changing the redirect URIs through that interface withdraws the approval:
consent was given for a destination, and it does not transfer to a new one.

**A metadata document is fetched, not trusted.** The URL is chosen by an
unauthenticated caller, so the request is treated as hostile: `https` only, no
redirects followed, private, loopback, link-local and CGNAT addresses refused
after DNS resolution, a 5 kB cap enforced while reading, a 5-second timeout, and
a JSON content type required. The name is resolved once and the connection is
pinned to the address that was checked, so a zone that answers differently the
second time cannot move the request onto an internal address. The document must
carry the same `client_id` it was fetched from, must not contain a
`client_secret`, and may only declare `none` or `private_key_jwt`. The `jwks_uri`
of a `private_key_jwt` client is fetched through the same guards, under a 64 kB
cap of its own. Concurrent lookups collapse into one request, rejections are
remembered briefly, and an origin that keeps failing is left alone for a while —
the query string is part of the `client_id`, so per-URL memory alone would not
stop one host from being fetched over and over. Every rejection answers a bare
`invalid_client`; the reason goes to the log only, so the policy cannot be
mapped by probing.

**The hub is also an OAuth client, outwards.** An upstream with an
[`oauth` block](/guide/configuration#upstreams-that-speak-oauth) is reached with
a token the hub obtained itself. Three things follow. The tokens are stored in
`state.json` in the clear, because they have to be presented — that file already
held live secrets, but it now holds credentials to a *third party*, which is
worth reflecting in how the volume is treated. The authorization server is found
by following the upstream's own metadata, so that URL is not the operator's
choice: discovery, token and registration requests go through the same guard as
an inbound metadata document, and an upstream that is publicly reachable cannot
point the hub at a private address. And the configured `headers` are never sent
to the authorization server, nor is an upstream token — the two request paths
are kept apart deliberately, because the SDK hands the same fetch to both.

**Nothing a client chooses can forge a log line.** A `client_id` may contain
newlines — the URL parser strips them, so such a value passes every structural
check while the raw string still reaches the log, where each line is given a
valid timestamp. A forged `mcp-hub: authentication failure from …` line matches
the fail2ban filter this project ships, which would have let anyone have any
address banned. Every client-chosen value is escaped and capped before it enters
a log line. The same clamping applies to a self-declared `client_name` before it
reaches the consent page: escaping alone still renders it, and a few hundred
characters would push the redirect target out of view.

**Finishing an upstream login takes more than the redirect.** The callback is
public by necessity, so it requires a `state` that is HMAC-signed with the hub's
own secret, single-use, and valid for fifteen minutes — *and* a valid hub
session in the same browser. Intercepting the redirect is not enough.

**Codes only travel somewhere they cannot be read off the wire.** Both
registration mechanisms hold `redirect_uris` to the same rule: `https` anywhere,
plain `http` only on a loopback address, and — for dynamic registration, which
native clients use — an application-specific scheme such as
`com.example.app:/callback`. A plaintext callback on a remote host is refused at
registration, because the code would otherwise be delivered in the clear on the
final redirect.

**The consent page names what cannot be forged.** For a metadata-document
client the page shows the document URL under *Identified by* — the name and
logo in that document are self-declared, the origin serving it is not
([draft §6.4](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00#name-security-considerations)).
When every redirect URI is a loopback address, the page says so: a code sent to
`http://127.0.0.1:…` could be collected by any program on that machine, and no
registration mechanism can change that.

**Consent is explicit.** Entering the password approves the client that asked
for it. While a login session is still valid, a client the hub has not seen
before gets a CSRF-protected *Approve / Deny* page rather than a silent code.
This is what stops a page in another tab from riding your session to obtain a
token.

**Tokens are short-lived and bound.** Access tokens are opaque and valid for
15 minutes. Opaque rather than self-contained on purpose: the value is a
reference to a stored record, so the hub can withdraw one, which is not possible
for a signed token that verifies on its own. Refresh tokens rotate, and reusing
a retired one is treated as a leak — it revokes the whole grant, the access
tokens issued under it included. Each token is bound (RFC 8707) to the one
resource it was issued for, so a token for one server reaches neither another
server nor `/hub` and `/health`.

Admin-minted API tokens are the exception and stay signed JWTs: they are for
clients that cannot do OAuth at all, and only their record is stored, which is
what `tokens revoke` deletes.

Nothing an attacker could present is written to `state.json`. Tokens are keyed
and stored by hash, so read access to the file does not yield a usable
credential.

**Revocation takes effect at once.** `mcp-hub-admin clients revoke <id>` removes
the approval and every refresh token, and the next request carrying an
already-issued access token is refused — no waiting for the 15-minute expiry.
It works whether or not the hub is running: the CLI is a second process on the
same state file, and both sides re-read it before touching it, so neither can
serve a stale copy or write one back over the other.

**API tokens are the deliberate exception.** `mcp-hub-admin tokens create`
mints long-lived tokens for [clients that cannot do
OAuth](/guide/client-compatibility#camp-2-api-clients-use-an-api-token) —
no refresh, no rotation, one resource. The mitigations are procedural: short
lifetimes, one token per integration, immediate revocation via
`tokens revoke` (verification refuses a revoked token even though its
signature still checks out). A leaked API token is equivalent to a leaked
password scoped to one resource.

## Rate limits

| Endpoint | Per IP | Global |
|---|---|---|
| `/register` | 20 per hour | 200 per hour |
| `/authorize` | 100 per 15 min | 1000 per 15 min |
| `/token` | 50 per 15 min | 500 per 15 min |
| `/login` | 100 per 15 min | 500 per 15 min |
| `/consent` | 100 per 15 min | 500 per 15 min |
| Failed logins | 10 per 15 min | 100 per 15 min |
| MCP traffic | `MCP_REQUESTS_PER_MINUTE` (120), `MCP_MAX_CONCURRENT_REQUESTS` (4) and `MCP_MAX_CONCURRENT_STREAMS` (32) **per OAuth client** | — |

The auth limiters run **before** body parsing, and they reject without
inserting the offending IP into their tables, so a flood of forged addresses
cannot grow memory. The global counters exist precisely because an attacker who
rotates `X-Forwarded-For` would otherwise dodge the per-IP limit.

Metadata-document fetches inherit the `/authorize` and `/token` limits, and are
throttled further on their own: a document is cached for at least a minute, a
rejected `client_id` for 30 seconds, concurrent lookups of the same URL collapse
into one request, and the cache holds at most 200 entries.

MCP traffic is limited per OAuth client rather than per IP: behind a reverse
proxy every client shares one source address, so an IP key would let one
connector starve the others.

Failed logins are written to the log as:

```
mcp-hub: authentication failure from <ip>
```

which is what the [fail2ban integration](/guide/deployment#fail2ban) matches on.

## Trusted proxies

`TRUSTED_PROXIES` is a comma-separated list of IPs or CIDRs allowed to set
`X-Forwarded-*`. It decides what `req.ip` is, and therefore what the login rate
limiter counts.

::: danger Two ways to get this wrong
**Too permissive:** if a client's own `X-Forwarded-For` is believed, it can
supply an address, rotate it, and sidestep the per-IP limit entirely.

**Unset:** every request appears to come from the proxy, so per-IP limiting
collapses into a single global counter. The hub logs a warning at startup when
this happens.
:::

List only your own reverse proxy, and make sure that proxy *overwrites*
`X-Forwarded-For` instead of appending to it. In nginx that means
`proxy_set_header X-Forwarded-For $remote_addr;` — not the `$proxy_add_…`
variant, which preserves whatever the client sent.

The global cap of 100 failed logins per 15 minutes applies regardless, as a
backstop.

## Browser-facing hardening

The login and consent pages deny framing and carry a restrictive
Content-Security-Policy. Auth responses are `Cache-Control: no-store`. The
session cookie is `HttpOnly`, `SameSite=Lax` and carries the `__Host-` prefix
when `EXTERNAL_URL` is HTTPS.

MCP request bodies are parsed only *after* the bearer token has been verified,
and are then bounded by `MCP_BODY_LIMIT`, the per-client request rate and the
per-client concurrency limit.

Child responses are bounded too: forwarded results stop at 8 MiB, tool discovery
at 100 pages, 10,000 tools and 16 MiB of metadata. Tool calls have a five-minute
deadline, and it is absolute by default — progress notifications do not extend
it, because a child that emits one every few seconds could otherwise hold a
request, and one of the client's concurrency slots, open forever. A deployment
with genuinely long-running tools can raise `MCP_CALL_TIMEOUT_MS` or set
`MCP_RESET_TIMEOUT_ON_PROGRESS=true`; both trade that bound for convenience and
need `HTTP_REQUEST_TIMEOUT_MS` and the reverse proxy raised to match. A sandbox
that sends an oversized or corrupt Docker frame has its stream closed, container
cleaned up and restart delayed by the normal supervisor backoff.

## What the hub does not protect against

- **A compromised stdio server.** See the trust model — this is the big one.
- **Password compromise.** One password, full access. There is no second
  factor.
- **A malicious reverse proxy.** The hub trusts it for TLS and client
  addresses.
- **Denial of service at the network layer.** Rate limits protect the process,
  not your bandwidth.
- **Data exfiltration by an authorized client.** Once approved, a client can
  call every tool its token covers — narrowed by that server's `allowTools` /
  `denyTools`, which are enforced on call and not merely in the listing. That
  filter constrains what a _client_ reaches through the hub. It is not a
  sandbox, it does not constrain the upstream itself, and it is no defence
  against a compromised stdio child, which per the trust model above can mint
  its own tokens. It also covers tools only: resources and prompts on a
  per-server path are untouched.

## Supply chain

Base images and GitHub Actions are pinned by digest or commit SHA. Every push
is gated by CodeQL, a required Trivy secret scan and Trivy image scans
(`HIGH`/`CRITICAL`, failing the build) before an image is published; images
carry an SBOM and `mode=max` provenance.
npm releases are published through Trusted Publishing (OIDC) with provenance
attestation. The registry publisher is version- and checksum-pinned. Release
tags must match `package.json` and point to a commit reachable from `main`.
Dependabot tracks npm, Docker and Actions dependencies weekly; only patch
updates to direct development dependencies are eligible for automatic merge.

The runtime image replaces the bundled npm with a current version and patches
the two vendored packages that still ship known-vulnerable releases, so a scan
of the published image reports no fixable HIGH or CRITICAL findings.
