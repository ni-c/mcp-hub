# What is mcp-hub?

mcp-hub serves many [Model Context Protocol](https://modelcontextprotocol.io)
servers from **one container**, published over HTTPS for ChatGPT connectors,
Claude (Web and Code), Mistral Le Chat, Cursor and any other Streamable-HTTP
MCP client — behind a built-in OAuth 2.1 authorization server protected by a
single password, with API tokens for clients that cannot do OAuth.

## The problem

Most MCP servers are stdio programs. They read JSON-RPC on stdin and write it
on stdout, and they assume a client that starts them as a child process. That
works beautifully on a laptop and not at all for a hosted client: ChatGPT
connectors, Claude Web and Le Chat speak HTTP and expect OAuth.

The usual fix is to wrap each stdio server in its own auth proxy. That works,
but the cost per server is real:

- a container image and a compose stack,
- a hostname and a TLS certificate,
- an OAuth authorization server with its own client registrations and its own
  state directory,
- a firewall rule, a log stream, a monitoring entry and a backup path.

Nine servers means nine of each. Every one of them has to be updated, scanned
and re-authorized separately, and every one is a place where an
authorization bug can hide.

## What mcp-hub does instead

One Node process holds all of it:

<figure class="hub-diagram">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="before-after-title">
  <title id="before-after-title">Comparison: one auth proxy container per server versus a single mcp-hub container</title>
  <defs>
    <marker id="arrow-ba" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" />
    </marker>
  </defs>

  <text x="12" y="24" class="label-title">Before — one wrapper per server</text>
  <text x="420" y="24" class="label-title">With mcp-hub</text>

  <rect class="node" x="12" y="44" width="150" height="46" rx="8" />
  <text x="87" y="66" text-anchor="middle" class="label-mono">a.example.net</text>
  <text x="87" y="82" text-anchor="middle" class="label-muted">proxy + OAuth + server</text>

  <rect class="node" x="12" y="102" width="150" height="46" rx="8" />
  <text x="87" y="124" text-anchor="middle" class="label-mono">b.example.net</text>
  <text x="87" y="140" text-anchor="middle" class="label-muted">proxy + OAuth + server</text>

  <rect class="node" x="12" y="160" width="150" height="46" rx="8" />
  <text x="87" y="182" text-anchor="middle" class="label-mono">c.example.net</text>
  <text x="87" y="198" text-anchor="middle" class="label-muted">proxy + OAuth + server</text>

  <text x="87" y="232" text-anchor="middle" class="label-muted">…once per server</text>
  <text x="87" y="252" text-anchor="middle" class="label-muted">N images · N certificates</text>
  <text x="87" y="270" text-anchor="middle" class="label-muted">N logins to maintain</text>

  <line class="edge edge-dashed" x1="360" y1="30" x2="360" y2="280" />

  <rect class="node-accent" x="420" y="44" width="180" height="162" rx="12" />
  <text x="510" y="70" text-anchor="middle" class="label-title">mcp.example.net</text>
  <text x="510" y="88" text-anchor="middle" class="label-muted">one image · one certificate</text>
  <text x="510" y="106" text-anchor="middle" class="label-muted">one login</text>
  <rect class="node" x="436" y="120" width="148" height="30" rx="6" />
  <text x="510" y="140" text-anchor="middle" class="label-mono">/hub</text>
  <rect class="node" x="436" y="160" width="148" height="30" rx="6" />
  <text x="510" y="180" text-anchor="middle" class="label-mono">/&lt;name&gt;/mcp</text>

  <rect class="node" x="640" y="52" width="104" height="34" rx="7" />
  <text x="692" y="74" text-anchor="middle" class="label-mono">server a</text>
  <rect class="node" x="640" y="98" width="104" height="34" rx="7" />
  <text x="692" y="120" text-anchor="middle" class="label-mono">server b</text>
  <rect class="node" x="640" y="144" width="104" height="34" rx="7" />
  <text x="692" y="166" text-anchor="middle" class="label-mono">server c</text>

  <path class="edge" d="M604 132 C 620 132, 620 69, 636 69" marker-end="url(#arrow-ba)" />
  <path class="edge" d="M604 132 C 620 132, 620 115, 636 115" marker-end="url(#arrow-ba)" />
  <path class="edge" d="M604 132 C 620 132, 620 161, 636 161" marker-end="url(#arrow-ba)" />

  <text x="510" y="232" text-anchor="middle" class="label-muted">one supervisor for every child</text>
  <text x="510" y="252" text-anchor="middle" class="label-muted">one OAuth state directory</text>
  <text x="510" y="270" text-anchor="middle" class="label-muted">one config file to edit</text>
</svg>
<figcaption>N wrapper containers collapse into one process — the servers themselves are unchanged.</figcaption>
</figure>

## What you get

**Your existing config works.** `/config/mcp.json` uses exactly Claude Code's
`mcpServers` schema, `${VAR}` expansion included. Copy entries across without
translating them. The one extra field, `"hub": false`, is ignored by Claude
Code, so the file stays interchangeable.

**Path-based routing.** Each server is reachable at `/<name>` and
`/<name>/mcp`. Register the ones you reach for daily as their own connectors.

**The `/hub` aggregate.** Registering nine connectors means nine servers' worth
of tool schemas in the model's context before a single question is asked.
`/hub` is one connector that exposes six meta-tools — `list_servers`,
`list_tools`, `get_tool_schema`, `call_tool` — and lets the model page in only
the schema it actually needs. Four schemas instead of N×tools.

**Client registration that does not need registering.** The hub is its own
OAuth 2.1 authorization server, and it takes the path the MCP specification now
prefers: a client uses an HTTPS URL as its `client_id` and hosts its own
[metadata document](/guide/client-registration) there, including the keys it
authenticates with. Nothing is issued, nothing expires, and a client that
reinstalls is still the same client. RFC 7591 dynamic registration stays
advertised beside it, so older clients keep working — and one setting retires it
when you no longer need it.

**Real supervision.** Children start at boot, get pinged every 60 seconds and
are restarted with exponential backoff when they die. A server that is down
answers `503` on its path and shows up in `/health` — it does not hang.

**Hot reload.** Editing `mcp.json` starts, stops or restarts exactly the
servers whose entries changed. Everything else keeps its connections.

**Stateless transport.** No session state is kept between requests, so a client
that reconnects without closing its previous session — which claude.ai does,
roughly every five minutes — cannot leak processes or memory.

**Both MCP revisions, on every endpoint.** `2026-07-28` and `2025-11-25`; the
client picks and cannot tell from the answers which one it got. On the 2026
revision a child server's [question reaches the
person](/guide/elicitation) at the far end, which is the one thing a gateway
used to take away from servers like `smtp-mcp` and `imap-mcp`.

**Light enough for a Raspberry Pi.** A stated project goal: one Node process,
no database — state is one JSON file plus an Ed25519 key under `/data` — a
six runtime dependencies, and multi-arch images (`amd64`/`arm64`). The
stateless transport and the missing database are not accidents; they are what
keeps the hub comfortable on a single-board computer.

## What it is not

- **Not a sandbox.** Every stdio server configured in the hub container runs as
  the same operating-system user as the hub and can read its mounted files and
  environment. Only run stdio packages you trust; put anything else in its own
  container and connect it as a remote server. See [Security](/guide/security).
- **Not a notification bridge.** Request/response traffic is delivered in full
  on both MCP revisions, and on `2026-07-28` that includes a child's
  [question to the user](/guide/elicitation) — but push traffic
  (`listChanged`, subscriptions) is not forwarded to clients on either.
- **Not a multi-user system.** There is one password. Anyone who has it can
  approve a client and reach every server the hub exposes.

## Next

- [Getting started](/guide/getting-started) — a working deployment
- [Configuration](/guide/configuration) — writing your `mcp.json`
- [Client registration](/guide/client-registration) — how clients get a `client_id`
- [Architecture](/guide/architecture) — what happens inside
- [Comparison](/guide/comparison) — when something else fits better
