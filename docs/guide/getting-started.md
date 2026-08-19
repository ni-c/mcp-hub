# Getting started

This walks from nothing to a working connector, with Claude as the example
client — ChatGPT, Le Chat, Cursor and the rest work the same way and have
their own notes on the [client compatibility](/guide/client-compatibility)
page. It assumes Docker and a reverse proxy that already terminates TLS for a
hostname you control.

## What you need

| | |
|---|---|
| A host with Docker | any architecture — images are published for `linux/amd64` and `linux/arm64` |
| A hostname with TLS | mcp-hub speaks plain HTTP; a reverse proxy in front terminates TLS |
| `htpasswd` | to hash the login password (`apache2-utils` / `httpd-tools`) |
| At least one MCP server | a stdio package, or a remote HTTP/SSE server you can reach |

::: tip Running without a container
`npx @ni-c/mcp-hub` works too and is handy for a first look. The container is
the recommended deployment because it carries the isolation, read-only root
filesystem and resource limits the [security model](/guide/security) assumes.

If all you want is the aggregate for a local, stdio-only client, none of this
page applies: `npx @ni-c/mcp-hub --stdio` needs no hostname, no TLS and no
password — see [local clients](/guide/clients#local-clients-over-stdio).
:::

## 1. Write the config

Create `mcp.json`. It is exactly Claude Code's `mcpServers` block:

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
    }
  }
}
```

`${VAR}` is expanded from the container's environment, so no secret has to be
written into the file. The [configuration page](/guide/configuration) covers
remote servers, `"hub": false` and the naming rules.

## 2. Hash the password

There is one password. It guards the OAuth login, and through it every server
the hub exposes.

```sh
htpasswd -bnBC 10 "" 'yourpassword' | tr -d ':\n'
```

The output — a `$2y$10$…` string — goes into `PASSWORD_HASH`.

## 3. Prepare the state directory

`/data` holds the Ed25519 JWT key, the registered OAuth clients, their
approvals and the refresh tokens. It **must** survive container recreates;
losing it means every connector has to authorize again.

The container runs as the unprivileged `node` user (uid 1000), so a
bind-mounted directory has to belong to that uid on the host:

```sh
mkdir -p data && sudo chown -R 1000:1000 data
```

::: warning A named volume does this for you
`chown -R node:node /data` in the image only affects the image layer. A
bind-mounted `./data` keeps the host's ownership, and the hub then cannot write
`jwt-key.pem`. If you use a named Docker volume instead, it inherits the
image's ownership and no `chown` is needed.
:::

## 4. Start the container

```sh
docker run -d --name mcp-hub \
  -p 127.0.0.1:7690:80 \
  -e EXTERNAL_URL="https://mcp.example.net" \
  -e PASSWORD_HASH='$2y$10$…' \
  -e TRUSTED_PROXIES="192.168.1.0/24" \
  -e PAPERLESS_API_TOKEN="…" \
  -v "$PWD/mcp.json:/config/mcp.json:ro" \
  -v "$PWD/data:/data" \
  ghcr.io/ni-c/mcp-hub:0.6.0
```

Two of those matter more than the rest:

- **`EXTERNAL_URL`** is the public HTTPS origin exactly as clients see it, with
  no trailing path. Every OAuth metadata document and every redirect is built
  from it.
- **`TRUSTED_PROXIES`** lists the addresses allowed to set `X-Forwarded-*`.
  Get it wrong and the login rate limiter counts the wrong IP — see
  [Security](/guide/security#trusted-proxies).

Access tokens are bound to one endpoint out of the box — nothing to switch on.
`RESOURCE_BOUND_TOKENS=false` exists only as a migration mode for deployments
from 0.4 and earlier; see [Connecting clients](/guide/clients#resource-bound-tokens).

The full list lives in the [environment reference](/reference/environment). A
Compose file with hardening options is on the
[deployment page](/guide/deployment#docker-compose).

## 5. Check that it came up

```sh
curl -fsS http://127.0.0.1:7690/livez
# {"status":"ok"}
```

`/livez` is the only unauthenticated endpoint; it reports that the process is
alive, nothing more. Per-server state is at `/health`, behind a bearer token.

Children are started in the background. If a server pulls a package at startup,
its path answers `503` until it is ready — that is expected, not an error.
`docker logs mcp-hub` shows each child's progress.

## 6. Put the reverse proxy in front

The proxy has to:

- terminate TLS for `mcp.example.net` and forward to `127.0.0.1:7690`,
- pass `X-Forwarded-Proto` and `Host`,
- allow streaming responses (turn response buffering **off**),
- allow a request to run longer than 310 seconds — MCP tool calls are long,
- cap request bodies at or below `MCP_BODY_LIMIT` (default 1 MB).

Sample configurations for nginx, Caddy and Traefik are on the
[deployment page](/guide/deployment#reverse-proxy).

## 7. Connect a client

::: code-group

```text [Claude Web]
Settings → Connectors → Add custom connector

  URL: https://mcp.example.net/hub

Claude registers itself, sends you to the login page, and you enter the
password once. From then on it reconnects silently.
```

```sh [Claude Code]
claude mcp add -t http paperless https://mcp.example.net/paperless/mcp
```

:::

Use `/hub` when you want one connector for everything, and `/<name>/mcp` for
the servers you use constantly. Both can be registered side by side. The
[clients page](/guide/clients) explains the approval flow and what each client
supports.

## Next

- [Configuration](/guide/configuration) — remote servers, hiding servers from
  `/hub`, hot reload
- [Deployment](/guide/deployment) — Compose, custom images, fail2ban, revoking
  clients
- [FAQ & troubleshooting](/guide/faq) — when something does not come up
