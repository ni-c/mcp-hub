# Configuration

mcp-hub reads a single file — `/config/mcp.json` by default, overridable with
`CONFIG_PATH`. Its schema is Claude Code's `mcpServers` block, so entries move
between the two without translation. Mount the file's **directory** into the
container (`./config:/config:ro`), not the file itself — see
[hot reload](#hot-reload) for why.

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
`health` · `livez` · `revoke` · `upstream` · `.well-known`

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
| `oauth` | optional; the hub authenticates itself with OAuth instead — see below |
| `command` | not allowed together with `url` |

Remote servers get the same treatment as children: connected at boot, pinged,
reconnected with backoff, reloaded on config change.

### Upstreams that speak OAuth

Where a static header is not enough, the hub can be an OAuth client in its own
right. It obtains and refreshes the token itself; no bridge process is involved.

```json
"some-saas": {
  "type": "http",
  "url": "https://saas.example.net/mcp",
  "oauth": {
    "mode": "static",
    "clientId": "abc123",
    "clientSecret": "${SAAS_SECRET}",
    "grant": "client_credentials",
    "scopes": ["mcp.read", "mcp.write"]
  }
}
```

| Field | Notes |
|---|---|
| `mode` | `static` (credentials the upstream issued you), `dcr` ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) dynamic registration) or `cimd` (the hub's own client metadata document) |
| `grant` | `client_credentials` for a machine-to-machine upstream, `authorization_code` where a person has to sign in |
| `clientId` | required for `static`, and only allowed there — the other modes get one from the upstream |
| `clientSecret` | optional, `static` only. Use `${VAR}` so it lives in the environment, not the file |
| `clientAuth` | optional: `client_secret_basic`, `client_secret_post` or `private_key_jwt`. Unset lets the upstream's metadata decide, which is what almost every upstream wants |
| `scopes` | optional array; sent at registration, authorization and token request alike |

`oauth` and a literal `Authorization` header are mutually exclusive and rejected
at startup: the OAuth token would either be overridden by the static header or,
worse, the header would be carried to the authorization server.

**`client_credentials` needs no attention.** The hub fetches a token at connect
time and renews it on its own; nothing to run, nothing to click.

**`authorization_code` needs one browser visit, once.** The hub cannot open a
browser, so the flow is started from the console and finished in yours:

```sh
docker exec mcp-hub node /app/dist/admin.js upstream login some-saas
```

It prints a URL. Open it in a browser **that is signed in to the hub**, approve
the upstream, and the redirect lands back on the hub, which stores the tokens
and connects the server. The command waits and reports when that has happened.

Both halves of that sentence matter: the callback checks a signed, single-use
`state` **and** a valid hub session, so intercepting the redirect is not enough
to complete somebody else's login.

**`private_key_jwt` instead of a shared secret.** Set
`"clientAuth": "private_key_jwt"` and the hub signs an assertion with a key of
its own rather than presenting a secret. The key lives at
`<DATA_PATH>/upstream-key.pem`, is created on first use, and is deliberately not
the key that signs the tokens the hub issues to its own clients — one key, one
job. The public half travels with the client metadata document or the
registration request, which is how the upstream verifies the assertion. It
cannot be combined with a `clientSecret`.

`cimd` additionally requires an `https` `EXTERNAL_URL` — the upstream fetches
the hub's client metadata document, and each `cimd` upstream gets its own at
`<EXTERNAL_URL>/.well-known/mcp-hub-client/<id>.json`. The identifier is derived
from the server name rather than being it, because that URL is public and your
server names are not. Two upstreams can therefore use `cimd` with different
scopes without one inheriting the other's.

### When an upstream needs attention

A server whose token is missing or no longer accepted does not sit in a restart
loop. It enters a distinct `unauthorized` state, visible in `/health` and in
`list_servers`, and the log says which command to run. Retrying would only
hammer an upstream that has already made up its mind.

```sh
docker exec mcp-hub node /app/dist/admin.js upstream list
docker exec mcp-hub node /app/dist/admin.js upstream status some-saas
docker exec mcp-hub node /app/dist/admin.js upstream refresh some-saas
docker exec mcp-hub node /app/dist/admin.js upstream register some-saas
docker exec mcp-hub node /app/dist/admin.js upstream logout some-saas
```

`logout` forgets the credentials here **and** asks the upstream to revoke the
token ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) and delete a dynamic
registration ([RFC 7592](https://www.rfc-editor.org/rfc/rfc7592)). If the
upstream cannot be reached, the local side still goes away and the command says
what failed.

Credentials are keyed to the configuration that obtained them. Change the `url`,
the mode, the grant or the scopes and the stored token is treated as belonging
to an identity the upstream no longer knows — `upstream list` shows it as
`stale` and a fresh login is needed. Editing a header or renaming the server
changes nothing.

::: tip stdio mode
`mcp-hub --stdio` has no HTTP listener, so a login cannot complete there. Point
`DATA_PATH` at the same `/data` an HTTP hub uses and it will reuse — and
refresh — a token authorized there. Without `DATA_PATH` such a server is
skipped, with one line saying so.
:::

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

`"hub": false` keeps a server's tools out of the `/hub` aggregate —
`list_tools` and `call_tool` refuse it and point at its own path
(`/internal-only/mcp`), which keeps working normally. It still appears in
`list_servers` with a `hidden` marker, and `wake_server`/`sleep_server`
[manage its lifecycle](/guide/on-demand#manual-control) like any other
on-demand server.

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

Hot reload is why the examples mount the config **directory**
(`./config:/config:ro`): with a directory mount every kind of host-side edit is
seen, including editors that save by writing a temp file and renaming it over
the original — which is how most editors save.

::: warning Single-file bind mounts miss renamed saves
`-v ./mcp.json:/config/mcp.json` still works, but it binds one *inode*. An
in-place edit is picked up (by the 3-second stat poller — single-file mounts
produce no inotify events in the container), while a rename-style save creates
a **new** inode the mount cannot follow: the container keeps reading the old
file forever and hot reload silently stops. The hub and the docker-proxy log a
startup warning when they detect this setup. If you are stuck on it, either
edit strictly in place (`cat new.json > mcp.json`) or recreate **both**
containers after each edit.
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
