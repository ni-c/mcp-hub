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
- [ ] The example's non-root user, dropped capabilities, read-only root
      filesystem, `pids_limit`, memory limit and `no-new-privileges`
- [ ] `/data/jwt-key.pem`, `/data/state.json`, the MCP config and every
      referenced environment variable treated as secrets
- [ ] Outbound network access restricted to what the configured servers need
- [ ] `/var/run/docker.sock` mounted **only** into `mcp-hub-docker-proxy`, never
      into the hub, and both images on the same version
- [ ] Sandbox secret files (`secretsFrom`) `chmod 640` and mounted into the
      proxy only

## Authentication and authorization

**One password.** There are no user accounts. Anyone who knows the password can
approve a client and reach every server the hub exposes. Use a strong one and
store the bcrypt hash, not the plain text.

**Registration is open, approval is not.** Dynamic client registration is
unauthenticated, as the MCP specification intends. Registering grants nothing —
a client receives an authorization code only after you confirmed it, and only
at the redirect URI you confirmed. Never-approved registrations are pruned at a
fixed cap of 100, so an open endpoint cannot grow the state file without bound;
approved clients are never pruned.

**Consent is explicit.** Entering the password approves the client that asked
for it. While a login session is still valid, a client the hub has not seen
before gets a CSRF-protected *Approve / Deny* page rather than a silent code.
This is what stops a page in another tab from riding your session to obtain a
token.

**Tokens are short-lived and bound.** Access tokens are EdDSA-signed JWTs valid
for 15 minutes; the verifier pins the algorithm rather than trusting the token
header. Refresh tokens rotate, reuse of a retired token revokes its family, and
a refresh cannot request more scope than the original grant. Each token is
additionally bound (RFC 8707) to the one resource it was issued for, so a token
for one server reaches neither another server nor `/hub` and `/health`.

**Revocation takes effect at once.** `mcp-hub-admin clients revoke <id>` removes
the approval and every refresh token, and sets a marker that rejects
already-issued access tokens immediately — no waiting for the 15-minute expiry.
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
  call every tool its token covers.

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
