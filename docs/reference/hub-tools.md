# Hub meta-tools

The `/hub` endpoint exposes exactly six tools, regardless of how many servers
are configured. Four of them are how a client reaches everything else; the
remaining two (`wake_server`, `sleep_server`) steer the
[on-demand lifecycle](/guide/on-demand).

Servers marked [`"hub": false`](/guide/configuration#hiding-a-server-from-hub)
keep their *tools* out of the aggregate: `list_tools`, `get_tool_schema` and
`call_tool` refuse them with a pointer to the server's own endpoint. Their
*lifecycle* is still the hub's business — `list_servers` shows them with a
`hidden` marker, and `wake_server`/`sleep_server` manage them like any other
on-demand server.

The [stdio mode](/guide/clients#local-clients-over-stdio) serves the same six
tools with the same behaviour — everything on this page applies there too.

## The intended sequence

```
list_servers  →  list_tools(server)  →  get_tool_schema(server, tool)  →  call_tool(...)
```

A model that already knows a tool's schema can skip straight to `call_tool`.
The tool descriptions are written to steer that order, so no client-side
prompting is needed.

## `list_servers`

> List all MCP servers available through this hub, with their status. Call this
> first to see what is available.

No input.

Returns one entry per hub-enabled server:

```json
[
  { "name": "paperless", "description": "Paperless-ngx", "status": "up",       "toolCount": 14 },
  { "name": "calendar",  "description": "CalDAV",        "status": "sleeping", "toolCount": 6, "hidden": true }
]
```

`description` is the child's advertised title, falling back to its server name.
`status` is `starting`, `up`, `down` or `sleeping`. Listing never wakes
anything — `sleeping` entries still show their cached `toolCount`. `hidden`
appears only on `"hub": false` servers: their tools are served exclusively by
their own endpoint, but `wake_server`/`sleep_server` accept them.

## `list_tools`

> List the tools of one MCP server with one-line descriptions. Use
> `get_tool_schema` before calling a tool for the first time.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |

Returns names with one-line descriptions — the first line of each tool's
description, truncated at 120 characters — so listing a large server stays
cheap:

```json
[
  { "name": "search_documents", "description": "Full-text search across all documents" },
  { "name": "get_document",     "description": "Fetch one document by ID" }
]
```

Errors: an unknown server, or an always-running server that is not `up`,
returns a tool error naming the state. A `sleeping` server answers from its
cached snapshot and is [pre-warmed in the background](/guide/on-demand#what-wakes-a-server-and-what-does-not) —
asking for its tools is the strongest hint a call follows.

## `get_tool_schema`

> Get the full description and JSON input schema of one tool, needed to
> construct arguments for `call_tool`.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |
| `tool` | string, required | tool name from `list_tools` |

Returns the untruncated description and the tool's JSON Schema:

```json
{
  "name": "search_documents",
  "description": "Full-text search across all documents…",
  "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
}
```

This is the step that keeps context small: full schemas are pulled in one at a
time, only for tools actually being used.

## `call_tool`

> Call a tool on one of the MCP servers. Arguments must match the schema from
> `get_tool_schema`.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |
| `tool` | string, required | tool name from `list_tools` |
| `arguments` | object, optional | arguments matching the tool's input schema |

The child's result is returned unchanged — content blocks, images, structured
content and `isError` all pass through.

Timeout: 5 minutes, reset whenever the child sends a progress notification. A
failure comes back as a tool error (`Tool call failed: …`) rather than an HTTP
error, so the model can react to it.

Calling a `sleeping` server wakes it first and blocks until it is up (120-second
budget) — the call itself then proceeds normally. Only a start that fails for
the whole budget surfaces as a tool error.

## `wake_server`

> Start an on-demand server now so its first tool call is fast. No-op if it is
> already running.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |

Blocks until the server is up and returns `{ name, status, toolCount }`. Useful
at the start of a longer workflow: the cold start happens while the model is
still planning instead of inside the first real call. An always-running server
(`keepAlive` or remote/socket) is refused with `… is always running`.

## `sleep_server`

> Stop an on-demand server immediately instead of waiting for its idle timeout.
> It restarts automatically on the next tool call.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |

Frees the server's resources right away — the stdio child exits, a sandbox
container is removed. Returns `{ name, status }`; already-sleeping servers are
a no-op. Always-running servers are refused.

## Caching

The hub keeps each child's tool list in memory and refreshes it when the child
sends `tools/list_changed`. `list_servers` and `list_tools` are therefore
answered without a round trip to the child. For on-demand servers the same
snapshot is [persisted to disk](/guide/on-demand#the-tool-cache), which is what
lets a sleeping server answer at all.

Clients are not notified of those changes — the [stateless
transport](/guide/architecture#stateless-transport) has no channel for
server-initiated messages — but the next `list_tools` call reflects them.

## When to use direct paths instead

`/hub` trades one extra round trip for a much smaller context. For a server you
call constantly, registering `/<name>/mcp` as its own connector puts the native
tools directly in the model's hands. The two mix well: give the daily drivers
their own connectors, mark them `"hub": false`, and let `/hub` cover the long
tail.
