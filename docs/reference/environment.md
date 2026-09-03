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

## Client registration

See [Client registration](/guide/client-registration) for what these do.

| Variable | Default | Description |
|---|---|---|
| `CLIENT_REGISTRATION` | `cimd,dcr` | Which mechanisms a client may use to obtain a `client_id`, comma-separated. `cimd` = [Client ID Metadata Documents](/guide/client-registration#client-id-metadata-documents), `dcr` = [RFC 7591 dynamic registration](/guide/client-registration#dynamic-client-registration). Dropping `dcr` removes `registration_endpoint` from the discovery document and makes `/register` answer `404`; dropping `cimd` removes `client_id_metadata_document_supported` and treats a URL `client_id` as unknown. An unknown value exits at startup. |
| `CIMD_ALLOWED_ORIGINS` | *(unset)* | Comma-separated bare https origins whose metadata documents are accepted, e.g. `https://chatgpt.com,https://vscode.dev`. Unset → every https origin is admitted and the consent page is the gate. Only origins can be pinned: ChatGPT's per-connector document path is random. An entry that is not a bare origin exits at startup. |
| `CIMD_ALLOW_PRIVATE_ADDRESSES` | `false` | Local development only. Lets metadata documents be fetched from private, loopback and link-local addresses. Logs a warning on every start — leaving it on in production is what a `client_id` aimed at your internal network or a cloud metadata endpoint needs to succeed. |
| `DCR_MAX_CLIENTS` | `500` | Ceiling on stored dynamic registrations. When it is reached the hub evicts the oldest never-approved ones; if every registration under the ceiling has been approved, a new registration is refused rather than a working connector being dropped. Only applies to dynamic registration — metadata documents are never stored. |
| `DCR_PENDING_TTL_HOURS` | `24` | How long a registration may sit without ever being approved before it is removed. Opening the authorization page counts as use and starts the window again, so a slow login is not cut short. |
| `DCR_INACTIVE_DAYS` | `90` | How long an approved registration may sit unused before it is removed together with its approval and refresh tokens. Use means an authorization or a token exchange. Approvals for metadata-document clients are left alone. |

## Sandboxed servers

Only relevant with `type: "docker"` entries — see [sandboxing](/guide/sandboxing).

| Variable | Default | Description |
|---|---|---|
| `DOCKER_HOST` | *(required with Docker servers)* | The **policy proxy's** socket, e.g. `unix:///run/proxy/docker.sock`. Missing values and direct `/var/run/docker.sock` access fail closed; other endpoints must pass the versioned proxy handshake. |

The proxy image (`ghcr.io/ni-c/mcp-hub-docker-proxy`) reads its own set:

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | `/config/mcp.json` | The same file the hub reads — mount its **directory** read-only (`./config:/config:ro`), like the hub does. It *is* the policy. Parsed without `${VAR}` expansion — the proxy holds none of the hub's secrets. |
| `LISTEN_SOCKET` | `/run/proxy/docker.sock` | Unix socket the hub connects to. Shared with the hub through a volume. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The real daemon. |
| `SANDBOX_SECRETS_DIR` | `/run/secrets` | Where `"secretsFrom": "x"` looks for `x.env`. Files must be regular, non-symlink, at most 64 KiB, mode 640 or stricter, with at most 100 unique non-NUL entries. |
| `SANDBOX_SECRETS_WATCH` | `true` | Watch referenced secret files and recreate the affected sandbox when their content changes. Set to `false` to apply secret changes only on the next container create. |
| `SOCKET_MODE` | `0660` | Permissions of `LISTEN_SOCKET`. Group access is how the hub gets in; world-writable would hand the policy to anyone on the host. |
| `LOG_FILE` | *(unset)* | Same mirroring as the hub's, useful because refusals are logged as `DENY`. |

## Limits and timeouts

| Variable | Default | Description |
|---|---|---|
| `MCP_BODY_LIMIT` | `1mb` | Maximum JSON body for authenticated MCP requests. Any Express/`bytes` size string. |
| `MCP_REQUESTS_PER_MINUTE` | `120` | MCP requests per minute **per OAuth client**. Positive integer. |
| `MCP_MAX_CONCURRENT_REQUESTS` | `4` | In-flight MCP requests per OAuth client — `POST`s carrying JSON-RPC, so this is the work a child server is doing at once. Positive integer. |
| `MCP_MAX_CONCURRENT_STREAMS` | `32` | Open listening streams per OAuth client: a 2025-era `GET`, or a `2026-07-28` [`subscriptions/listen`](/guide/subscriptions) `POST` whose response stays open. Both are the standing channel rather than work in progress, so neither is charged to the budget above. Bounds how many sessions one client may hold open, not how much work it may cause. Positive integer. |
| `MCP_CALL_TIMEOUT_MS` | `300000` | Deadline for one forwarded tool call or request. Raise it only for a deployment that genuinely runs long tools; a stuck call holds one of the concurrency slots above. |
| `MCP_RESET_TIMEOUT_ON_PROGRESS` | `false` | Whether a progress notification restarts that deadline. `true` is convenient for long tools and gives up the absolute bound: a child that emits progress forever keeps the call open forever. |
| `IDLE_TIMEOUT_MINUTES` | `60` | Minutes of inactivity before an [on-demand server](/guide/on-demand) is put to sleep. `0` disables on-demand lifecycling entirely — every server starts at boot and keeps running, the pre-0.9 behaviour. Per-server `idleMinutes` overrides it. |
| `HTTP_HEADERS_TIMEOUT_MS` | `10000` | Node's header timeout. |
| `HTTP_REQUEST_TIMEOUT_MS` | `310000` | Complete request timeout — slightly above the default tool-call timeout. Your reverse proxy must allow at least as long, and raising `MCP_CALL_TIMEOUT_MS` means raising this and the proxy with it. A `subscriptions/listen` stream is exempt: it is idle by design and would otherwise be cut every few minutes, which looks exactly like a flaky upstream and is not. Its lifetime is bounded by `MCP_SUBSCRIPTION_MAX_MS` instead — and your reverse proxy needs a matching read timeout. |

## Elicitation

What the hub will carry when a server asks the person at the far end a
question. Full behaviour: [Elicitation](/guide/elicitation).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_ELICITATION` | `true` | The whole feature. `false` is the emergency brake for every server at once; per server, use `"passthrough": "off"` in `mcp.json`. |
| `MCP_ELICITATION_MAX_ROUNDS` | `8` | How often one tool call may come back for more input. The hub keeps nothing between requests, so the count travels inside the sealed state. Each round is a fresh call the caller pays for. |
| `MCP_ELICITATION_STATE_TTL_MS` | `900000` | How long a half-finished call stays resumable. |
| `MCP_ELICITATION_MAX_MESSAGE_BYTES` | `4096` | One prompt, measured in bytes. It is read by a person; anything longer is not a prompt. Oversized text is truncated, not refused. |
| `MCP_ELICITATION_MAX_PAYLOAD_BYTES` | `131072` | The whole question including its schemas. Over this the call is refused rather than trimmed — there is no way to shorten a schema safely. |

These five are read by the request path, so an unusable value logs and keeps
the default.

## Diagnostics

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_DIAGNOSTICS` | `false` | Adds [`describe_connection`](/reference/hub-tools#describe-connection) to `/hub`, a seventh meta-tool that reports how the caller is connected. Off because every tool a client can see costs context in every conversation it has, and most deployments never need to ask. Read per request. |

The switch is about context cost, not safety. The tool reports only what the
caller's own request already carried and says nothing about any other client —
which is why it exists in place of a tool that hands out the hub's log. That log
carries upstream URLs, internal hostnames and text written by the children;
serving it through `/hub` would let any registered connector read what every
other connector is doing.

## Subscriptions

What a client may watch, and how much of it the hub will hold open. See
[Subscriptions](/guide/subscriptions).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_SUBSCRIPTIONS` | `true` | The whole feature. `false` is the emergency brake for every server at once; per server, use `"subscriptions": "off"` in `mcp.json`. |
| `MCP_MAX_SUBSCRIPTIONS` | `1024` | Open `subscriptions/listen` streams one route will serve before refusing the next. |
| `MCP_SUBSCRIPTION_MAX_URIS` | `64` | Resource URIs one filter may name. Every URI is an upstream subscription the hub holds and reconciles, so an unbounded list is a way to make it do unbounded work on one request. Over this the call is refused with `-32602`. |
| `MCP_SUBSCRIPTION_KEEPALIVE_MS` | `15000` | SSE keepalive on a listen stream; `0` disables it. |
| `MCP_SUBSCRIPTION_DEBOUNCE_MS` | `250` | Coalescing window. Within it, repeats of the same event collapse to one — which is what the notification means anyway: read it again, not here is what changed. `0` delivers each event as it arrives. |
| `MCP_SUBSCRIPTION_MAX_MS` | `1800000` | How long one stream may stay open before the hub closes it; `0` means as long as the socket lives. A reaper for clients that go away without closing anything. |

These six are read by the request path as well, with the same fallback
behaviour. A listen stream is charged to `MCP_MAX_CONCURRENT_STREAMS`, not
`MCP_MAX_CONCURRENT_REQUESTS`.

An invalid value for any of the integer variables read at startup aborts with a
clear message rather than silently falling back. The two call-timeout variables
are the exception: they are read by the request path itself, so an unusable
value logs and keeps the hardened default instead of taking the hub down.

## Paths

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | `/config/mcp.json` | The `mcpServers` config file. Watched for changes — mount its **directory** (`./config:/config:ro`), not the file: a single-file bind mount misses rename-style editor saves and logs a startup warning. |
| `DATA_PATH` | `/data` | JWT key, OAuth clients, approvals, refresh tokens. Must be persistent. |
| `TOOL_CACHE_PATH` | `<DATA_PATH>/tool-cache.json` | Snapshots (identity, capabilities, tool list) of [on-demand servers](/guide/on-demand), so they can boot into `sleeping` instead of warm-starting. Not writable → a startup warning and on-demand servers warm-start at every boot. |
| `LOG_FILE` | *(unset)* | Mirror every hub log line into this file with an ISO-8601 UTC prefix, in addition to the console. See [fail2ban](/guide/deployment#fail2ban). |
| `PORT` | `80` in the image, `3000` otherwise | Listen port. |

`DATA_PATH` is also read by `mcp-hub-admin`, so the admin CLI needs it set to
the same directory when run outside the container.

## In stdio mode

`--stdio` ([local clients](/guide/clients#local-clients-over-stdio)) starts no
listener and no authorization server, so most of the table above does not
apply. What it reads:

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | `mcp.json` in the working directory | Same file, same hot reload. A missing file starts an empty hub instead of failing — the client that spawned the process has nowhere to show a startup error. |
| `IDLE_TIMEOUT_MINUTES` | `60` | As above. Worth keeping on: a hub spawned per client session would otherwise start every configured server at every launch. |
| `TOOL_CACHE_PATH` | `.mcp-hub/tool-cache.json` beside the config | As above, but there is no `DATA_PATH` here to derive it from. |
| `DATA_PATH` | *(unset)* | Optional here, unlike over HTTP. Point it at an HTTP hub's `/data` to reuse and refresh an [upstream OAuth token](/guide/configuration#upstreams-that-speak-oauth) authorized there. Without it, a server with an `oauth` block is skipped — there is no listener for a browser to return to. |
| `LOG_FILE` | *(unset)* | Same as above. Logging otherwise goes to stderr: in stdio mode stdout carries the protocol, so `console.log` output is moved out of the way. |

Everything else — `EXTERNAL_URL`, `PASSWORD*`, `TRUSTED_PROXIES`,
`RESOURCE_BOUND_TOKENS`, `DEFAULT_RESOURCE`, `PORT`, the rate limits and the
HTTP timeouts — is HTTP-only and ignored. The call
timeouts (`MCP_CALL_TIMEOUT_MS` and friends) apply, since they belong to the
proxying path.

## Full Compose example

```yaml
environment:
  EXTERNAL_URL: "https://mcp.example.net"
  PASSWORD_HASH: "${PASSWORD_HASH}"
  TRUSTED_PROXIES: "192.168.1.0/24"

  MCP_BODY_LIMIT: "1mb"
  MCP_REQUESTS_PER_MINUTE: "120"
  MCP_MAX_CONCURRENT_REQUESTS: "4"
  MCP_MAX_CONCURRENT_STREAMS: "32"

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
