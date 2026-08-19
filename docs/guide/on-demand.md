# On-demand servers

Local servers — stdio children and [Docker sandboxes](/guide/sandboxing) — do
not have to run around the clock. By default the hub starts them when they are
used and puts them back to sleep after 60 minutes of inactivity, which is what
makes a dozen servers affordable on a Raspberry Pi: memory is held only by the
servers actually in use.

Remote and socket servers are unaffected — the hub does not manage the
lifetime of a process it did not start.

## The lifecycle

```
boot ──(cached snapshot)──► sleeping ──(tool call / wake)──► up
                                ▲                            │
                                └────── 60 min idle ─────────┘
```

- **Boot.** A server whose snapshot is in the [tool cache](#the-tool-cache)
  boots straight into `sleeping` and costs nothing. Without a snapshot (first
  run, changed config) it warm-starts once to fill the cache and idles out
  afterwards.
- **Use.** The first `tools/call` (or resources/prompts request) wakes the
  server and **blocks until it is up** — transparent to the client, the first
  call is just slower. Concurrent requests share the one start; after 120
  seconds without a successful start the request fails with the server's last
  error.
- **Idle.** Every forwarded request resets the server's idle clock. Once it has
  been quiet for the idle timeout, the hub tears it down: the stdio child
  exits, a sandbox container is removed. The hub's internal keepalive ping does
  not count as activity — and a sleeping server is not pinged at all.

## What wakes a server (and what does not)

A client with several hub paths configured enumerates all of them on session
start. If that woke the fleet, on-demand would save nothing — so the handshake
is answered from the snapshot:

| Request | Effect on a sleeping server |
|---|---|
| `initialize`, `tools/list` on `/<name>/mcp` | answered from the snapshot; stays asleep |
| `tools/call`, resources, prompts on `/<name>/mcp` | wakes, blocks until up, then forwards |
| `/hub` `list_tools`, `get_tool_schema` | answered from the snapshot **and** pre-warms the server in the background — asking for schemas is the strongest hint a call follows |
| `/hub` `call_tool` | wakes and blocks, like a direct call |
| `/hub` `list_servers`, `/health` | read state only; never wake anything |

The cached `tools/list` reflects the server as it last ran. After a wake the
live list is forwarded again and the snapshot is refreshed.

## Configuration

On-demand is the default for every stdio and docker server. Two per-server
fields and one environment variable tune it:

```json
{
  "mcpServers": {
    "paperless":  { "command": "npx", "args": ["-y", "paperless-mcp"] },
    "search":     { "command": "npx", "args": ["-y", "search-mcp"], "idleMinutes": 15 },
    "workhorse":  { "command": "npx", "args": ["-y", "busy-mcp"], "keepAlive": true }
  }
}
```

| Field | Meaning |
|---|---|
| `keepAlive: true` | This server always runs, exactly like pre-0.9 behaviour. For the servers you use constantly, or whose cold start you never want to pay. |
| `idleMinutes` | Per-server idle timeout, overriding the global default. Mutually exclusive with `keepAlive`. |

```yaml
environment:
  IDLE_TIMEOUT_MINUTES: "60"   # global default; 0 disables on-demand entirely
  TOOL_CACHE_PATH: "/data/tool-cache.json"
```

`IDLE_TIMEOUT_MINUTES: "0"` restores the previous behaviour wholesale: every
server starts at boot and is restarted for as long as it is configured.

Like `hub`, both fields are mcp-hub extensions that Claude Code ignores, so the
file remains a valid Claude Code config. Setting them on a remote or socket
server is a config error.

## The tool cache

`/data/tool-cache.json` holds one snapshot per on-demand server: its identity,
capabilities and tool list, keyed to a **sha256 hash** of the server's expanded
config — the hash invalidates the entry when the config (or a referenced
`${VAR}`) changes without writing any secret to disk. The snapshot is written
after every successful start and tool-list refresh.

The default lives under `DATA_PATH`, which a normal deployment already
persists. If the path is not writable the hub logs a warning and falls back to
warm-starting every on-demand server at boot — everything still works, boots
are just as heavy as before 0.9.

## Manual control

Two [/hub meta-tools](/reference/hub-tools) steer the lifecycle directly:
`wake_server` starts a server ahead of time so a workflow's first real call is
fast, `sleep_server` frees its resources immediately instead of waiting out the
idle timeout. Both also accept [`"hub": false`](/guide/configuration#hiding-a-server-from-hub)
servers — hiding a server's tools from the aggregate does not take away the
hub's responsibility for its lifecycle. `list_servers` and [`/health`](/reference/endpoints#status) both
report `sleeping` as a distinct state — and `/health` counts it as healthy,
because a sleeping server is exactly what this feature is for.

## Crashes

While a server is being used, a crash is handled as always: restart with
exponential backoff. But a server that keeps failing **without anyone asking
for it** stops being restarted after five attempts — it goes back to `sleeping`
with its `lastError` kept visible in `list_servers` and `/health`, and the next
tool call simply tries a fresh start. A broken npm package cannot occupy the
machine in an endless restart loop overnight.

## What it costs

The first call to a sleeping server pays its cold start: a few seconds for a
pinned npm package, longer for `npx` downloads on a slow disk or a sandbox
image with a slow entrypoint. If a particular server's cold start is annoying,
`keepAlive: true` on that one server buys back the old behaviour exactly —
sizing the trade per server is the point of the flag.
