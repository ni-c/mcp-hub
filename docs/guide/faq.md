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
with different IDs, and the `via` column says `dcr`, the client is
re-registering instead of persisting its credentials. A client that uses a
[metadata document](/guide/client-registration) cannot have this problem: its
ID is a URL that does not change.

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

### Connecting gets `429` with `Too many concurrent MCP streams`

That client has more sessions open than `MCP_MAX_CONCURRENT_STREAMS` (default
32) allows. Each connected session holds one `GET` SSE stream, and every window
of the same editor or CLI counts, since they all share one OAuth client. Closing
sessions frees the slots; raise the limit if you genuinely run that many.

Before 0.9.2 those streams were charged to `MCP_MAX_CONCURRENT_REQUESTS`
instead, so the fifth session against the default of four could not connect at
all — it got `Too many concurrent MCP requests` on an otherwise idle hub. If
you see that message on connect, upgrade rather than raise the limit.

### Editing `mcp.json` does nothing

With the recommended directory mount (`./config:/config:ro`) any host-side edit
is picked up within a few seconds. If nothing happens, check two things:

1. **A single-file bind mount plus an editor that saves via rename.** Most
   editors write a temp file and rename it over the original — that creates a
   new inode, and a `-v ./mcp.json:/config/mcp.json` mount keeps pointing at
   the old one, so the container never sees the edit (compare
   `md5sum mcp.json` on the host with `docker exec mcp-hub md5sum
   /config/mcp.json`). The hub logs a `single-file bind mount` warning at
   startup for this setup. Immediate fix: recreate **both** the hub and the
   docker-proxy container; lasting fix: mount the directory.
2. **A broken edit.** Look for `ignoring broken config update: …` in the log:
   an edit that does not parse is rejected and the previous configuration
   stays active.

### Notifications from a server never arrive

Check the revision first. On **`2026-07-28`** notifications do arrive, but only
on a stream you opened: send `subscriptions/listen` naming the types you want —
nothing is pushed at a client that did not ask. See
[Subscriptions](/guide/subscriptions).

On **`2025-11-25`** they are not delivered at all, and the hub does not
advertise them either — that revision needs a channel the stateless transport
does not keep.

Three more things worth checking on the newer revision:

- **The child has to declare it.** A type the child never advertised is left out
  of the acknowledgment; compare what you asked for against what came back.
- **A sleeping server watches nothing.** An [on-demand](/guide/on-demand) child
  holds no connection. The subscription is re-established when something wakes
  it, and you are then told to re-read — but the change itself is not reported.
- **`subscriptions: "off"`** on that server withdraws its right to push.

A question from a server is *not* in that category, despite looking like it.
On `2026-07-28` an elicitation is a result rather than a push, so it does
travel — see [Elicitation](/guide/elicitation). If one is not reaching you,
check that your client negotiated that revision, that the server did too, and
that `passthrough` is not `"off"` for it.

### A sandboxed server is refused with `403 … does not match the configuration`

The [docker proxy](/guide/sandboxing#the-policy-proxy) derives its policy from
`mcp.json`, and both it and the hub poll that file independently. Right after an
edit, the hub can send a create request built from the new configuration while
the proxy still holds the old one. The server goes `down` and the supervisor
retries — it resolves itself within seconds.

If it does not, the two are not reading the same file: check that both
containers mount the same config directory, and that they run the same image
version.

### A sandboxed server never comes up and the log shows `not JSON`

The server writes to **stdout**, which under stdio is the protocol channel. Its
logging has to go to stderr; the hub prefixes that with the server name and
passes it through to its own stderr.

### A server name is rejected

Names must match `[a-zA-Z0-9_-]+`, and these are reserved because the hub
serves them itself: `mcp`, `hub`, `authorize`, `token`, `register`, `login`,
`consent`, `health`, `livez`, `revoke`, `upstream`, `.well-known`.

### A server shows `sleeping` / the first tool call is slow

Working as intended: stdio and docker servers run [on demand](/guide/on-demand)
by default and sleep after 60 minutes of inactivity. The first call to a
sleeping server pays its cold start; everything after that is normal. If one
server's cold start bothers you, give it `"keepAlive": true`; to disable the
feature entirely, set `IDLE_TIMEOUT_MINUTES: "0"`.

### A server shows `unauthorized`

That is a remote server with an
[`oauth` block](/guide/configuration#upstreams-that-speak-oauth) whose token is
missing, expired beyond recovery, or refused by the upstream. Unlike `down` it
is **not** retried: another attempt cannot produce a credential, and hammering
an upstream that has already said no helps nobody.

```sh
docker exec mcp-hub node /app/dist/admin.js upstream status <name>
```

`login_required` means there is nothing stored — run `upstream login <name>` and
open the URL it prints in a browser signed in to this hub. `stale` means the
stored credential belongs to a configuration that has since changed, so a fresh
login is needed. For a `client_credentials` upstream there is no browser step;
`upstream refresh <name>` will show you the actual error.

The server comes up on its own once the login succeeds — no restart needed.

### An upstream login says "Not signed in"

The callback deliberately requires two things: the signed, single-use `state`
the CLI generated, **and** a valid hub session in the same browser. Open
`https://your-hub/` first, sign in with the hub password, then open the
authorization URL again. Without the session check, anyone who intercepted the
redirect could finish somebody else's login.

### A crashed server stopped restarting

An on-demand server that fails five restarts in a row **without being used**
goes back to `sleeping` instead of crash-looping forever — its `lastError`
stays visible in `list_servers` and `/health`. The next tool call (or
`wake_server`) tries a fresh start. Servers with `keepAlive: true` keep the
endless-backoff behaviour.

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
