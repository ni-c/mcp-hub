# Architecture

What actually happens between an HTTP request arriving and a tool result going
back out.

## One process, four parts

<figure class="hub-diagram">
<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="arch-title">
  <title id="arch-title">Internal structure of the mcp-hub process</title>
  <defs>
    <marker id="arrow-arch" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" />
    </marker>
  </defs>

  <rect class="node" x="10" y="132" width="118" height="60" rx="10" />
  <text x="69" y="158" text-anchor="middle" class="label-title">Express app</text>
  <text x="69" y="176" text-anchor="middle" class="label-muted">trust proxy</text>

  <rect class="node-accent" x="164" y="18" width="212" height="304" rx="12" />
  <text x="270" y="42" text-anchor="middle" class="label-title">request pipeline</text>

  <rect class="node" x="180" y="56" width="180" height="34" rx="7" />
  <text x="270" y="78" text-anchor="middle" class="label-mono">early rate limit</text>
  <rect class="node" x="180" y="100" width="180" height="34" rx="7" />
  <text x="270" y="122" text-anchor="middle" class="label-mono">bearer verify</text>
  <rect class="node" x="180" y="144" width="180" height="34" rx="7" />
  <text x="270" y="166" text-anchor="middle" class="label-mono">resource check</text>
  <rect class="node" x="180" y="188" width="180" height="34" rx="7" />
  <text x="270" y="210" text-anchor="middle" class="label-mono">per-client gate</text>
  <rect class="node" x="180" y="232" width="180" height="34" rx="7" />
  <text x="270" y="254" text-anchor="middle" class="label-mono">parse body ≤ 1 MB</text>
  <rect class="node" x="180" y="276" width="180" height="34" rx="7" />
  <text x="270" y="298" text-anchor="middle" class="label-mono">route</text>

  <rect class="node" x="412" y="40" width="150" height="56" rx="10" />
  <text x="487" y="64" text-anchor="middle" class="label-title">OAuth 2.1 AS</text>
  <text x="487" y="82" text-anchor="middle" class="label-muted">DCR · PKCE · consent</text>

  <rect class="node" x="412" y="122" width="150" height="56" rx="10" />
  <text x="487" y="146" text-anchor="middle" class="label-title">/hub server</text>
  <text x="487" y="164" text-anchor="middle" class="label-muted">4 meta-tools</text>

  <rect class="node" x="412" y="204" width="150" height="56" rx="10" />
  <text x="487" y="228" text-anchor="middle" class="label-title">proxy server</text>
  <text x="487" y="246" text-anchor="middle" class="label-muted">built per request</text>

  <rect class="node" x="412" y="286" width="150" height="42" rx="10" />
  <text x="487" y="313" text-anchor="middle" class="label-title">supervisor</text>

  <rect class="node" x="612" y="122" width="136" height="42" rx="9" />
  <text x="680" y="148" text-anchor="middle" class="label-mono">stdio child</text>
  <rect class="node" x="612" y="176" width="136" height="42" rx="9" />
  <text x="680" y="202" text-anchor="middle" class="label-mono">stdio child</text>
  <rect class="node" x="612" y="230" width="136" height="42" rx="9" />
  <text x="680" y="256" text-anchor="middle" class="label-mono">remote upstream</text>

  <path class="edge-accent" d="M128 162 L160 162" marker-end="url(#arrow-arch)" />
  <path class="edge" d="M376 68 L408 68" marker-end="url(#arrow-arch)" />
  <path class="edge" d="M360 293 C 386 293, 386 150, 408 150" marker-end="url(#arrow-arch)" />
  <path class="edge" d="M360 293 C 386 293, 386 232, 408 232" marker-end="url(#arrow-arch)" />
  <path class="edge edge-dashed" d="M562 150 L608 143" marker-end="url(#arrow-arch)" />
  <path class="edge edge-dashed" d="M562 232 L608 197" marker-end="url(#arrow-arch)" />
  <path class="edge" d="M562 307 C 590 307, 592 251, 608 251" marker-end="url(#arrow-arch)" />
</svg>
<figcaption>The supervisor owns the connections; the OAuth server, the hub server and the per-request proxies all borrow them.</figcaption>
</figure>

**The Express app** sets `trust proxy` from `TRUSTED_PROXIES`, mounts `/livez`
unauthenticated, mounts the auth router, and then registers two routes per
configured server plus `/hub`.

**The OAuth authorization server** is the MCP SDK's `mcpAuthRouter` with a
custom provider: password login, per-client approval, EdDSA JWTs, rotating
refresh tokens, all persisted to one JSON file.

**The supervisor** owns one long-lived MCP client per configured server — a
child process for stdio entries, an HTTP/SSE client for remote ones — and keeps
it alive.

**The proxy layer** builds a throwaway MCP `Server` per HTTP request that
forwards requests verbatim to the supervisor's client.

## Request pipeline

The order of the middleware is deliberate:

1. **Rate limit** — before anything is parsed, and before an unknown IP is
   inserted into any table.
2. **Bearer verification** — an EdDSA JWT with a pinned algorithm.
3. **Resource check** — with `RESOURCE_BOUND_TOKENS=true`, the token's audience
   must match this endpoint.
4. **Per-client gate** — requests per minute and in-flight concurrency, keyed
   by OAuth client rather than IP.
5. **Body parsing** — capped at `MCP_BODY_LIMIT`, and only now, so an
   unauthenticated request never allocates a megabyte.
6. **Routing** — to `/hub`, to one server's proxy, or 404.

An unauthenticated request costs a JWT verification and nothing more: no disk
access, no bcrypt, no allocation proportional to the body.

## Stateless transport

Each MCP request gets a fresh `Server` and a `StreamableHTTPServerTransport`
with `sessionIdGenerator: undefined` — no session ID, no server-side session
table. When the HTTP response closes, both are closed and forgotten.

The reason is concrete: claude.ai reconnects roughly every five minutes and
does **not** send a session `DELETE` first. Any per-session state would
accumulate one entry per reconnect, forever, and take processes or memory with
it. Statelessness makes that impossible by construction.

The cost is that server-initiated messages have nowhere to go. `listChanged`
notifications, resource subscriptions and sampling are not delivered to
clients. Request/response traffic — tools, resources, prompts, completions — is
forwarded in full, and the proxy advertises only the capabilities its child
actually declared.

## Supervisor lifecycle

<figure class="hub-diagram">
<svg viewBox="0 0 760 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="life-title">
  <title id="life-title">Supervisor state machine: starting, up, down, backoff, restart</title>
  <defs>
    <marker id="arrow-life" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" />
    </marker>
  </defs>

  <rect class="node" x="24" y="90" width="130" height="52" rx="10" />
  <text x="89" y="114" text-anchor="middle" class="label-title">starting</text>
  <text x="89" y="131" text-anchor="middle" class="label-muted">path answers 503</text>

  <rect class="node-accent" x="238" y="90" width="130" height="52" rx="10" />
  <text x="303" y="114" text-anchor="middle" class="label-title">up</text>
  <text x="303" y="131" text-anchor="middle" class="label-muted">ping every 60 s</text>

  <rect class="node" x="452" y="90" width="130" height="52" rx="10" />
  <text x="517" y="114" text-anchor="middle" class="label-title">down</text>
  <text x="517" y="131" text-anchor="middle" class="label-muted">exit or ping timeout</text>

  <rect class="node" x="640" y="90" width="104" height="52" rx="10" />
  <text x="692" y="114" text-anchor="middle" class="label-title">backoff</text>
  <text x="692" y="131" text-anchor="middle" class="label-muted">1 s → 5 min</text>

  <path class="edge-accent" d="M154 116 L234 116" marker-end="url(#arrow-life)" />
  <text x="194" y="106" text-anchor="middle" class="label-muted">connected</text>
  <path class="edge" d="M368 116 L448 116" marker-end="url(#arrow-life)" />
  <path class="edge" d="M582 116 L636 116" marker-end="url(#arrow-life)" />

  <path class="edge" d="M692 90 C 692 40, 400 34, 89 34 L89 86" marker-end="url(#arrow-life)" />
  <text x="392" y="26" text-anchor="middle" class="label-muted">restart after the delay, doubling each time</text>

  <path class="edge edge-dashed" d="M303 142 C 303 196, 420 200, 480 200 C 620 200, 692 190, 692 146" marker-end="url(#arrow-life)" />
  <text x="470" y="220" text-anchor="middle" class="label-muted">5 minutes of uptime resets the delay to 1 s</text>
</svg>
<figcaption>The backoff never gives up — a server whose dependency is down recovers on its own once the dependency returns.</figcaption>
</figure>

The numbers, all fixed:

| | |
|---|---|
| Ping interval | 60 s |
| Ping timeout | 30 s |
| Initial backoff | 1 s |
| Maximum backoff | 5 min |
| Backoff reset | after 5 min of uptime |

A ping failure is treated as death: the client is closed, which triggers the
same restart path an exit would. There is no separate "unhealthy but running"
state to reason about.

While a server is not `up`, its path answers a JSON-RPC error with HTTP `503`
naming the state. A client gets a clear failure instead of a hanging request.

## Configuration hot reload

The config file is watched two ways: `fs.watch` on the parent directory, and
`fs.watchFile` polling the file itself every 3 seconds. Both funnel into a
300 ms debounce.

The poller is not belt-and-braces. With a single-file bind mount —
`-v ./mcp.json:/config/mcp.json` — an edit on the host produces no inotify
event inside the container: the container's `/config` directory never changes,
and the mount is a bind of one inode. Without polling, host-side edits would
never be seen.

On a change the new file is parsed and diffed against the running
configuration. Added servers start, removed servers stop, changed servers
restart, untouched servers keep their connections. A file that fails to parse
is logged and ignored — the previous configuration stays live.

## The `/hub` aggregate

Registering nine connectors puts nine servers' worth of tool schemas into the
model's context before a question is asked. `/hub` inverts that: one connector,
four meta-tools, and schemas fetched only when needed.

<figure class="hub-diagram">
<svg viewBox="0 0 760 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="hub-title">
  <title id="hub-title">Context cost of N connectors versus the hub aggregate</title>

  <text x="16" y="26" class="label-title">N direct connectors</text>
  <rect class="node" x="16" y="40" width="330" height="26" rx="5" />
  <rect class="node" x="16" y="72" width="330" height="26" rx="5" />
  <rect class="node" x="16" y="104" width="330" height="26" rx="5" />
  <rect class="node" x="16" y="136" width="330" height="26" rx="5" />
  <text x="181" y="58" text-anchor="middle" class="label-muted">server A — every tool schema</text>
  <text x="181" y="90" text-anchor="middle" class="label-muted">server B — every tool schema</text>
  <text x="181" y="122" text-anchor="middle" class="label-muted">server C — every tool schema</text>
  <text x="181" y="154" text-anchor="middle" class="label-muted">…</text>
  <text x="181" y="184" text-anchor="middle" class="label-muted">N × tools, loaded up front</text>

  <line class="edge edge-dashed" x1="392" y1="14" x2="392" y2="196" />

  <text x="430" y="26" class="label-title">One /hub connector</text>
  <rect class="node-accent" x="430" y="40" width="314" height="26" rx="5" />
  <text x="587" y="58" text-anchor="middle" class="label-mono">list_servers</text>
  <rect class="node-accent" x="430" y="72" width="314" height="26" rx="5" />
  <text x="587" y="90" text-anchor="middle" class="label-mono">list_tools</text>
  <rect class="node-accent" x="430" y="104" width="314" height="26" rx="5" />
  <text x="587" y="122" text-anchor="middle" class="label-mono">get_tool_schema</text>
  <rect class="node-accent" x="430" y="136" width="314" height="26" rx="5" />
  <text x="587" y="154" text-anchor="middle" class="label-mono">call_tool</text>
  <text x="587" y="184" text-anchor="middle" class="label-muted">4 schemas; the rest fetched on demand</text>
</svg>
<figcaption>The trade is one extra round trip before an unfamiliar tool call, in exchange for a context that does not scale with the number of servers.</figcaption>
</figure>

The hub keeps a per-server tool cache, refreshed when a child sends
`tools/list_changed`, so `list_tools` answers without a round trip to the
child. `call_tool` forwards with a five-minute timeout that resets on progress
notifications.

Servers marked `"hub": false` are invisible here: `list_servers` omits them and
`call_tool` refuses them. Their own paths are unaffected.

See the [meta-tool reference](/reference/hub-tools) for the exact schemas.

## State on disk

`/data` holds everything that must survive a restart:

| File | Contents |
|---|---|
| `jwt-key.pem` | the Ed25519 signing key, generated on first boot |
| `state.json` | registered OAuth clients, approvals, refresh-token families, revocation markers |
| `mcp-hub.log` | only if `LOG_FILE` points there |

There is no database and no migration step. A corrupt `state.json` is moved
aside as `state.json.corrupt-<timestamp>` and the hub boots with empty state
rather than crash-looping — connectors then have to authorize again, which is
recoverable, unlike a hub that will not start.

Losing `/data` invalidates every connector authorization. Treat both files as
secrets: anyone holding `jwt-key.pem` can mint access tokens.
