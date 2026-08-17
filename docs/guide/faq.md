# FAQ & troubleshooting

## Startup

### A server's path returns 503 right after starting

Expected, for a while. Children are started in the background and their paths
answer `503` until the MCP handshake completes. A server that downloads a
package on first run can take minutes on a slow machine.

Check `docker logs mcp-hub` and `/health`. If the state stays `down` and the
`restarts` counter climbs, that child is crash-looping — its own stderr in the
container log will say why.

### The hub will not start: `Undefined environment variable in config`

`${VAR}` may expand to an *empty* value, but a variable that is not defined at
all aborts parsing of the whole file — one entry takes every server with it.

Pass the variable through explicitly in your Compose file, even as an empty
string:

```yaml
environment:
  SOME_TOKEN: "${SOME_TOKEN:-}"
```

### `EACCES` writing `/data/jwt-key.pem`

The container runs as uid 1000 and a bind-mounted directory keeps the host's
ownership:

```sh
sudo chown -R 1000:1000 ./data
```

`chown` in the Dockerfile only affects the image layer, not your bind mount. A
named volume inherits the image's ownership and avoids this entirely.

### The hub logs a warning about `TRUSTED_PROXIES`

It is unset, so every request appears to come from the reverse proxy and
per-IP rate limiting collapses into one global counter. Set it to your proxy's
address — see [Security](/guide/security#trusted-proxies).

## Authorization

### The client is redirected to `http://…` instead of `https://…`

`EXTERNAL_URL` must be the exact public HTTPS origin, with no trailing path,
and the proxy has to pass `X-Forwarded-Proto`. Every OAuth metadata document
and redirect is built from that value.

### Every connector suddenly has to authorize again

Three causes, in order of likelihood:

1. **`/data` was recreated.** The JWT key and all client records live there. A
   fresh directory means a fresh authorization server as far as clients are
   concerned.
2. **You upgraded to 0.5.0 or later.** Resource binding is on by default now,
   which intentionally retires tokens issued without a resource. It is a
   one-time cost; `RESOURCE_BOUND_TOKENS=false` postpones it.
3. **A client was revoked** with `mcp-hub-admin clients revoke`.

### I get an *Approve / Deny* page instead of the password prompt

That is the intended behaviour when a login session is still valid (30 minutes)
and a client the hub has not seen before asks for authorization. The hub knows
who you are but will not hand a code to an unconfirmed client.

If you did not initiate the request, deny it.

### A client keeps asking for the password

An approval is bound to the client ID **and** the redirect URI it was approved
for. A client that changes its redirect target counts as new. Loopback URIs
(`http://127.0.0.1:<port>/…`) match regardless of port, so a desktop client
picking a fresh port each time is not the cause.

Check `mcp-hub-admin clients list` — if the same client name appears many times
with different IDs, the client is re-registering instead of persisting its
credentials.

### `/health` returns 401

By design since v0.3.0: `/health` exposes per-server state and sits behind a
bearer token. Point liveness monitoring at `/livez`, which is unauthenticated
and returns `{"status":"ok"}`.

Since 0.5.0 the token also has to be the one for `/hub` — `/health` lists every
server, so a token bound to a single server does not cover it.

### fail2ban banned my own clients

A generic "ban on repeated 401" jail reading the reverse proxy's access log
will do this: the MCP authorization flow produces legitimate 401 responses on
every new connection. Exclude the hub's vhost from such jails, and use the
purpose-built [`mcp-hub-auth` filter](/guide/deployment#fail2ban), which matches
the hub's own log lines instead.

## Runtime

### Tool calls fail after about a minute

Your reverse proxy is cutting the request. MCP tool calls are long-running; the
hub allows 310 seconds and its internal call timeout is 5 minutes (reset on
progress notifications). Raise `proxy_read_timeout` / the equivalent to at
least 330 seconds.

### Requests get `429` with `MCP request rate limit exceeded`

The per-client gate: `MCP_REQUESTS_PER_MINUTE` (default 120) and
`MCP_MAX_CONCURRENT_REQUESTS` (default 4), counted **per OAuth client**. Raise
them if a legitimate client needs more.

### Editing `mcp.json` does nothing

The hub watches the file's directory *and* polls the file every 3 seconds, so a
host-side edit should be picked up within a few seconds — the poller exists
precisely because single-file bind mounts produce no inotify events in the
container.

If nothing happens, look for `ignoring broken config update: …` in the log: an
edit that does not parse is rejected and the previous configuration stays
active.

### Notifications from a server never arrive

The transport is stateless, so server-initiated messages — `listChanged`,
resource subscriptions, sampling — are not delivered to clients. This is a
deliberate trade for not leaking session state on every client reconnect. Tool,
resource and prompt request/response traffic is unaffected.

### A sandboxed server is refused with `403 … does not match the configuration`

The [docker proxy](/guide/sandboxing#the-policy-proxy) derives its policy from
`mcp.json`, and both it and the hub poll that file independently. Right after an
edit, the hub can send a create request built from the new configuration while
the proxy still holds the old one. The server goes `down` and the supervisor
retries — it resolves itself within seconds.

If it does not, the two are not reading the same file: check that both
containers mount the same `mcp.json`, and that they run the same image version.

### A sandboxed server never comes up and the log shows `not JSON`

The server writes to **stdout**, which under stdio is the protocol channel. Its
logging has to go to stderr; the hub prefixes that with the server name and
passes it through to its own stderr.

### A server name is rejected

Names must match `[a-zA-Z0-9_-]+`, and these are reserved because the hub
serves them itself: `mcp`, `hub`, `authorize`, `token`, `register`, `login`,
`consent`, `health`, `livez`, `revoke`, `.well-known`.

## Operating

### How do I update?

```sh
docker compose pull && docker compose up -d
```

Pin a version tag rather than `latest` so this happens when you decide. Read
the [changelog](/reference/changelog) first — `0.3.0` moved `/health` behind
authentication, which breaks external monitors that polled it.

### Can several people use one hub?

Not meaningfully. There is one password and no user accounts; anyone who knows
it can approve a client and reach every server. For roles, audit trails or SSO,
use something built for that — see [Comparison](/guide/comparison).

### Can I hide a server from `/hub` but keep it reachable?

Yes: `"hub": false`. Its own path keeps working. This is the usual setup for
servers you register as their own connector anyway, so they are not offered
twice.

### Is a mixed setup possible — some servers isolated?

That is the recommended shape when trust levels differ. Run the sensitive
servers in their own containers and add them to the hub as `type: "http"`
entries. Clients see one endpoint either way, and a remote upstream has no
access to the hub's process or files.

### Where do I report a security issue?

[GitHub private vulnerability
reporting](https://github.com/ni-c/mcp-hub/security/advisories/new). Please do
not open a public issue, and leave real credentials and hostnames out of the
report.
