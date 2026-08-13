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

## Limits and timeouts

| Variable | Default | Description |
|---|---|---|
| `MCP_BODY_LIMIT` | `1mb` | Maximum JSON body for authenticated MCP requests. Any Express/`bytes` size string. |
| `MCP_REQUESTS_PER_MINUTE` | `120` | MCP requests per minute **per OAuth client**. Positive integer. |
| `MCP_MAX_CONCURRENT_REQUESTS` | `4` | In-flight MCP requests per OAuth client. Positive integer. |
| `HTTP_HEADERS_TIMEOUT_MS` | `10000` | Node's header timeout. |
| `HTTP_REQUEST_TIMEOUT_MS` | `310000` | Complete request timeout — slightly above the 5-minute tool-call timeout. Your reverse proxy must allow at least as long. |

An invalid value for any of the integer variables aborts startup with a clear
message rather than silently falling back.

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
