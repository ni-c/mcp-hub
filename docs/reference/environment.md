# Environment variables

Everything mcp-hub reads from its own environment. Variables referenced as
`${VAR}` from `mcp.json` are separate — those are your servers' secrets and are
described under [configuration](/guide/configuration#environment-expansion).

## Required

| Variable | Description |
|---|---|
| `EXTERNAL_URL` | The public base URL exactly as clients see it, e.g. `https://mcp.example.net`. No trailing path. Every OAuth metadata document, redirect and resource identifier is derived from it. Missing → the process exits at startup. |
| `PASSWORD_HASH` *or* `PASSWORD` | The login secret. `PASSWORD_HASH` takes precedence and is what you should use. |

Generate the hash with:

```sh
htpasswd -bnBC 10 "" 'yourpassword' | tr -d ':\n'
```

`PASSWORD` compares in constant time, but it puts the plain-text secret in the
container's environment where every child process and `docker inspect` can see
it. Use it only for a throwaway test.

## Recommended

| Variable | Default | Description |
|---|---|---|
| `TRUSTED_PROXIES` | *(unset)* | Comma-separated IPs/CIDRs allowed to set `X-Forwarded-*`. Decides what `req.ip` is, and therefore what the login rate limiter counts. Unset → a startup warning and per-IP limiting degrades to one global counter. See [Security](/guide/security#trusted-proxies). |
| `RESOURCE_BOUND_TOKENS` | `true` | RFC 8707 resource binding: a token is valid only for `/hub` (which covers `/health`) or the one `/<name>/mcp` it was issued for. `false`/`0` restores the pre-0.5 behaviour where unbound tokens reach every path — a migration mode that logs a warning on every start. |
| `DEFAULT_RESOURCE` | *(unset)* | Server name (or `hub`) to bind a token to when the OAuth client sends **no** `resource` parameter at all (older Codex logins, Google ADK, Gemini Enterprise). Unset → such requests are refused with `invalid_target`. The token is still bound either way — never global. |

## Sandboxed servers

Only relevant with `type: "docker"` entries — see [sandboxing](/guide/sandboxing).

| Variable | Default | Description |
|---|---|---|
| `DOCKER_HOST` | *(required with Docker servers)* | The **policy proxy's** socket, e.g. `unix:///run/proxy/docker.sock`. Missing values and direct `/var/run/docker.sock` access fail closed; other endpoints must pass the versioned proxy handshake. |

The proxy image (`ghcr.io/ni-c/mcp-hub-docker-proxy`) reads its own set:

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | `/config/mcp.json` | The same file the hub reads, mounted read-only. It *is* the policy. Parsed without `${VAR}` expansion — the proxy holds none of the hub's secrets. |
| `LISTEN_SOCKET` | `/run/proxy/docker.sock` | Unix socket the hub connects to. Shared with the hub through a volume. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The real daemon. |
| `SANDBOX_SECRETS_DIR` | `/run/secrets` | Where `"secretsFrom": "x"` looks for `x.env`. Files must be regular, non-symlink, at most 64 KiB, mode 640 or stricter, with at most 100 unique non-NUL entries. |
| `SOCKET_MODE` | `0660` | Permissions of `LISTEN_SOCKET`. Group access is how the hub gets in; world-writable would hand the policy to anyone on the host. |
| `LOG_FILE` | *(unset)* | Same mirroring as the hub's, useful because refusals are logged as `DENY`. |

## Limits and timeouts

| Variable | Default | Description |
|---|---|---|
| `MCP_BODY_LIMIT` | `1mb` | Maximum JSON body for authenticated MCP requests. Any Express/`bytes` size string. |
| `MCP_REQUESTS_PER_MINUTE` | `120` | MCP requests per minute **per OAuth client**. Positive integer. |
| `MCP_MAX_CONCURRENT_REQUESTS` | `4` | In-flight MCP requests per OAuth client. Positive integer. |
| `MCP_CALL_TIMEOUT_MS` | `300000` | Deadline for one forwarded tool call or request. Raise it only for a deployment that genuinely runs long tools; a stuck call holds one of the concurrency slots above. |
| `MCP_RESET_TIMEOUT_ON_PROGRESS` | `false` | Whether a progress notification restarts that deadline. `true` is convenient for long tools and gives up the absolute bound: a child that emits progress forever keeps the call open forever. |
| `HTTP_HEADERS_TIMEOUT_MS` | `10000` | Node's header timeout. |
| `HTTP_REQUEST_TIMEOUT_MS` | `310000` | Complete request timeout — slightly above the default tool-call timeout. Your reverse proxy must allow at least as long, and raising `MCP_CALL_TIMEOUT_MS` means raising this and the proxy with it. |

An invalid value for any of the integer variables read at startup aborts with a
clear message rather than silently falling back. The two call-timeout variables
are the exception: they are read by the request path itself, so an unusable
value logs and keeps the hardened default instead of taking the hub down.

## Paths

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | `/config/mcp.json` | The `mcpServers` config file. Watched for changes. |
| `DATA_PATH` | `/data` | JWT key, OAuth clients, approvals, refresh tokens. Must be persistent. |
| `LOG_FILE` | *(unset)* | Mirror every hub log line into this file with an ISO-8601 UTC prefix, in addition to the console. See [fail2ban](/guide/deployment#fail2ban). |
| `PORT` | `80` in the image, `3000` otherwise | Listen port. |

`DATA_PATH` is also read by `mcp-hub-admin`, so the admin CLI needs it set to
the same directory when run outside the container.

## Full Compose example

```yaml
environment:
  EXTERNAL_URL: "https://mcp.example.net"
  PASSWORD_HASH: "${PASSWORD_HASH}"
  TRUSTED_PROXIES: "192.168.1.0/24"

  MCP_BODY_LIMIT: "1mb"
  MCP_REQUESTS_PER_MINUTE: "120"
  MCP_MAX_CONCURRENT_REQUESTS: "4"

  LOG_FILE: "/data/mcp-hub.log"

  # Referenced as ${…} inside mcp.json:
  PAPERLESS_API_TOKEN: "${PAPERLESS_API_TOKEN}"
```

::: warning Pass every `${VAR}` your config references
A variable referenced in `mcp.json` may be **empty**, but if it is undefined
the whole config fails to parse and no server starts. Declaring it in the
Compose `environment:` block — with `${VAR:-}` if it may be absent — avoids
that.
:::
