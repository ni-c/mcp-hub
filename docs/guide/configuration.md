# Configuration

mcp-hub reads a single file — `/config/mcp.json` by default, overridable with
`CONFIG_PATH`. Its schema is Claude Code's `mcpServers` block, so entries move
between the two without translation.

```json
{
  "mcpServers": {
    "paperless": {
      "command": "paperless-mcp",
      "args": [],
      "env": {
        "PAPERLESS_BASE_URL": "http://paperless.example.net:8000",
        "PAPERLESS_API_TOKEN": "${PAPERLESS_API_TOKEN}"
      }
    },
    "homeassistant": {
      "type": "http",
      "url": "http://homeassistant.example.net:8123/api/mcp",
      "headers": { "Authorization": "Bearer ${HA_TOKEN}" }
    },
    "internal-only": {
      "command": "some-mcp",
      "args": [],
      "hub": false
    }
  }
}
```

## Server names

The key becomes the URL path, so it is restricted to `[a-zA-Z0-9_-]+`.

These names are reserved and rejected at load time, because the hub itself
serves them:

`mcp` · `hub` · `authorize` · `token` · `register` · `login` · `consent` ·
`health` · `livez` · `revoke` · `.well-known`

The check is case-insensitive — `Hub` is rejected just like `hub`.

## Stdio servers

The default kind. `command` is required; `args` and `env` are optional.

```json
"paperless": {
  "command": "paperless-mcp",
  "args": ["--read-only"],
  "env": { "PAPERLESS_API_TOKEN": "${PAPERLESS_API_TOKEN}" }
}
```

Each stdio server runs as a supervised child process: started at boot, pinged
every 60 seconds, restarted with exponential backoff if it exits. Its `stderr`
is inherited, so its log lines appear in `docker logs` alongside the hub's.

A child does **not** inherit the hub's full environment. It gets the MCP SDK's
default-safe set (`HOME`, `PATH`, `SHELL`, `TERM`, `USER` and friends) plus
exactly the keys listed under `env`. Anything a server needs has to be named
there.

::: danger Install servers at a pinned version
`command` is executed as-is. Pointing it at `npx -y some-package` or an
unpinned `uvx` means the container downloads and runs whatever the registry
serves at that moment, as the hub's own user. Install reviewed, exactly
versioned packages [into a custom image](/guide/deployment#custom-image)
instead. See the [trust model](/guide/security#trust-model).
:::

## Remote servers

A server that already speaks HTTP does not need a child process. Give it a
`url` and, if it needs one, static `headers`:

```json
"homeassistant": {
  "type": "http",
  "url": "http://homeassistant.example.net:8123/api/mcp",
  "headers": { "Authorization": "Bearer ${HA_TOKEN}" }
}
```

| Field | Notes |
|---|---|
| `type` | `http` (also accepted: `streamable-http`, `streamable_http`) or `sse`. Omitting `type` but giving a `url` implies a remote server. |
| `url` | required, must parse as a URL |
| `headers` | optional object of strings, injected on **every** request to that upstream |
| `command` | not allowed together with `url` |

Remote servers get the same treatment as children: connected at boot, pinged,
reconnected with backoff, reloaded on config change.

### Upstreams with interactive OAuth

Static headers cannot drive an OAuth flow that expects a browser. Bridge those
with an [`mcp-remote`](https://github.com/geelen/mcp-remote) stdio entry and
persist its token cache under `/data`:

```json
"some-saas": {
  "command": "mcp-remote",
  "args": ["https://saas.example.net/mcp"],
  "env": { "MCP_REMOTE_CONFIG_DIR": "/data/mcp-remote" }
}
```

Be aware that a bridge with rotating refresh tokens and a supervisor that
restarts on failure can fight each other: if the bridge rotates its token and
then crashes before persisting it, the restart loops. Prefer an upstream that
accepts a long-lived token in a header where you have the choice.

## Sandboxed servers

A server you have not reviewed should not run in the hub's container at all.
Two kinds put it in its own container without giving up stdio — the hub either
creates the container itself over the Docker API, or connects to a socket a
container you started is listening on:

```json
"scraper": {
  "type": "docker",
  "image": "registry.example/scraper-mcp@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "volumes": ["/srv/scraper/data:/data"],
  "network": "scraper-net",
  "memory": "384m",
  "pidsLimit": 128,
  "cpus": 0.75
},
"scary": { "type": "unix", "socket": "/run/mcp/scary.sock" },
"far-away": { "type": "tcp", "host": "sandbox-host", "port": 9000 }
```

Both speak the same newline-delimited JSON-RPC as stdio, so there is no HTTP
listener, no bearer token and no bridge process in the image. The fields, the
policy proxy that keeps the Docker socket away from the hub, and the Compose
wiring are described under [sandboxing](/guide/sandboxing).

## Environment expansion

`${VAR}` anywhere in `command`, `args`, `env` values, `url` or `headers` is
replaced from the hub process's environment — the same behaviour as Claude
Code. Keep secrets in the container environment (`.env` + Compose) rather than
in the config file.

::: warning An undefined variable breaks the whole config
`${VAR}` may expand to an **empty** string, but a variable that is not defined
at all raises a `ConfigError` — and because the file is parsed as a unit, that
one entry takes every other server down with it. Pass the variable through
explicitly in your Compose file, even if its value is empty.
:::

If a single server is missing a secret it needs at runtime, only that child
crash-loops (backoff up to 5 minutes, it never gives up); the others keep
running.

## Hiding a server from `/hub`

```json
"internal-only": { "command": "some-mcp", "args": [], "hub": false }
```

`"hub": false` removes a server from the `/hub` aggregate — `list_servers`
does not mention it and `call_tool` refuses it. Its own path
(`/internal-only/mcp`) keeps working normally.

Use it for the servers you register as dedicated connectors anyway: they are
already in the client's context with full schemas, so listing them a second
time through `/hub` only duplicates them.

Claude Code ignores unknown fields, so a file carrying `hub` still works as a
Claude Code config.

## Lifecycle: `keepAlive` and `idleMinutes`

Stdio and docker servers run [on demand](/guide/on-demand) by default: started
when used, put to sleep after `IDLE_TIMEOUT_MINUTES` (default 60) of
inactivity. Two fields tune that per server:

```json
"workhorse": { "command": "busy-mcp", "keepAlive": true },
"scraper":   { "type": "docker", "image": "scraper@sha256:…", "idleMinutes": 15 }
```

`keepAlive: true` exempts a server — it always runs, as every server did before
0.9. `idleMinutes` overrides the global idle timeout for one server; the two
are mutually exclusive. Both are rejected on remote and socket servers, whose
processes the hub does not own. Like `hub`, Claude Code ignores them.

## Hot reload

The hub watches the config file and applies changes without a restart:

- **added** → the server is started
- **removed** → the server is stopped
- **changed** → the server is restarted with the new settings
- untouched servers keep their connections

A change is detected by comparing the parsed configuration, so reformatting the
file changes nothing. If an edit leaves the file invalid, the error is logged
(`ignoring broken config update: …`) and the previous configuration stays
active — a typo cannot take the hub down.

::: details Why there is also a polling watcher
The hub watches the config file's *directory* with `fs.watch`, plus the file
itself with `fs.watchFile` (3-second polling). The fallback is not redundancy
for its own sake: with a single-file bind mount — `-v ./mcp.json:/config/mcp.json` —
an edit on the host does not produce an inotify event inside the container,
because the mount is a bind of one inode and the container's `/config`
directory never changes. Without the poller, host-side edits would never be
noticed.

Mounting the *directory* instead of the file avoids this, and is worth doing if
you edit the config often.
:::

## Validation errors

The config is validated strictly at load. Common messages:

| Message | Cause |
|---|---|
| `Config must be an object with a top-level "mcpServers" object` | the file is valid JSON but not the expected shape |
| `Server name "…" is reserved` | see the reserved list above |
| `Server "…" is missing a "command" string` | a stdio entry without `command` |
| `Server "…": "command" and "url" are mutually exclusive` | an entry that is half stdio, half remote |
| `Server "…": unknown type "…"` | `type` is not `stdio`, `http`, `sse`, `docker`, `unix`, `tcp` |
| `Server "…": "image" must not use ${VAR}` | only `env` values expand for docker servers ([why](/guide/sandboxing#docker-servers)) |
| `Server "…": "privileged" is not supported` | the sandbox flags are fixed, not configurable |
| `Undefined environment variable in config: ${VAR}` | the variable is not set in the container |

At startup these are fatal — the hub refuses to run on a config it cannot
parse. On reload they are logged and ignored.
