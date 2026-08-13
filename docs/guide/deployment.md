# Deployment

Three ways to run mcp-hub, then everything around it: the reverse proxy, custom
images, logging, fail2ban and client revocation.

## Option A — prebuilt image from GHCR

Recommended. Multi-arch images (`linux/amd64`, `linux/arm64`) are published on
every push to `main` and on every `vX.Y.Z` release tag.

```sh
docker pull ghcr.io/ni-c/mcp-hub:0.5.0
```

| Tag | Points at |
|---|---|
| `latest` | tip of `main` |
| `X.Y.Z` | a release |
| `X.Y` | the latest patch of that minor |
| `sha-<commit>` | one specific build |

Use a version tag, not `latest`, so updates happen when you decide. For a truly
immutable deployment, record the resolved digest from `docker image inspect`
and pin `ghcr.io/ni-c/mcp-hub:0.5.0@sha256:…`.

Update with `docker compose pull && docker compose up -d`.

## Option B — build from source

```sh
git clone https://github.com/ni-c/mcp-hub.git && cd mcp-hub
cp docker-compose.example.yml docker-compose.yml   # adjust
cp mcp.json.example mcp.json                       # adjust
docker compose up -d --build
```

## Option C — npm, without a container

```sh
CONFIG_PATH=./mcp.json DATA_PATH=./data PASSWORD_HASH='…' \
  EXTERNAL_URL='https://mcp.example.net' \
  npx @ni-c/mcp-hub
```

The package is [`@ni-c/mcp-hub`](https://www.npmjs.com/package/@ni-c/mcp-hub)
— the unscoped npm name belongs to an unrelated project — and provides the
`mcp-hub` and `mcp-hub-admin` binaries. Outside a container the port defaults
to `3000`.

This is useful for development and for hosts where you cannot run Docker, but
it gives up the isolation, read-only root filesystem and resource limits that
[SECURITY.md](/guide/security#deployment-checklist) assumes.

## Docker Compose

The repository ships a hardened
[`docker-compose.example.yml`](https://github.com/ni-c/mcp-hub/blob/main/docker-compose.example.yml).
The parts that matter:

```yaml
services:
  mcp-hub:
    image: ghcr.io/ni-c/mcp-hub:0.5.0   # pin a digest in production
    container_name: mcp-hub
    restart: unless-stopped

    # Bind to the interface your reverse proxy reaches.
    ports:
      - "127.0.0.1:7690:80"

    environment:
      EXTERNAL_URL: "https://mcp.example.net"
      TRUSTED_PROXIES: "192.168.1.0/24"
      PASSWORD_HASH: "${PASSWORD_HASH}"
      # Secrets referenced as ${VAR} in mcp.json, supplied through .env:
      PAPERLESS_API_TOKEN: "${PAPERLESS_API_TOKEN}"

    volumes:
      - "./mcp.json:/config/mcp.json:ro"
      - "./data:/data"           # chown 1000:1000 on the host

    # Hardening — keep these.
    read_only: true
    mem_limit: 1g
    pids_limit: 300
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=64m,mode=1777
      - /home/node/.cache:size=128m,mode=0700,uid=1000,gid=1000
```

`read_only: true` means child servers cannot write into the image. Deliberate
persistent state belongs under `/data`; transient caches belong in the tmpfs
mounts.

::: warning The bind-mounted data directory
The container runs as uid 1000. A bind-mounted `./data` keeps the host's
ownership, so it has to be chowned once:

```sh
mkdir -p data && sudo chown -R 1000:1000 data
```

Without this the hub cannot create `jwt-key.pem`. A **named volume** inherits
the image's ownership instead and needs no chown.
:::

## Reverse proxy

mcp-hub speaks plain HTTP and expects a proxy in front of it. Requirements:

| Requirement | Why |
|---|---|
| TLS termination for `EXTERNAL_URL`'s host | the hub builds OAuth metadata and redirects from that origin |
| Pass `Host` and `X-Forwarded-Proto` | otherwise generated URLs are wrong |
| **Overwrite** `X-Forwarded-For` | an appended header lets clients forge their address — see [Security](/guide/security#trusted-proxies) |
| Response buffering **off** | MCP responses stream |
| Request timeout above 310 s | tool calls are long; the hub's own default is 310 s |
| Body limit at or below `MCP_BODY_LIMIT` | reject oversized payloads before they reach Node |

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.net;

    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:7690;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # $remote_addr overwrites; $proxy_add_x_forwarded_for would append
        # whatever the client sent.
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header Connection        "";

        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 330s;
        proxy_send_timeout 330s;
    }
}
```

### Caddy

```txt [Caddyfile]
mcp.example.net {
	request_body {
		max_size 1MB
	}
	reverse_proxy 127.0.0.1:7690 {
		flush_interval -1
		transport http {
			read_timeout 330s
		}
	}
}
```

Caddy *appends* to `X-Forwarded-For` by default. Configure
[`trusted_proxies`](https://caddyserver.com/docs/caddyfile/options#trusted-proxies)
in the global options so client-supplied values are discarded, then set
`TRUSTED_PROXIES` to Caddy's address.

## Custom image {#custom-image}

The published image contains Node, `npx`, `uv`/`uvx`, Python 3 and `git`, but
no MCP servers. Install the ones you need at exact versions in your own layer:

```dockerfile
FROM ghcr.io/ni-c/mcp-hub:0.5.0
USER root
RUN npm install -g paperless-mcp@1.2.3 \
 && uv tool install --python 3.12 some-python-mcp==0.4.1
USER node
```

Then reference the installed binaries directly in `mcp.json` — `"command":
"paperless-mcp"`, not `"npx"`.

Three things to watch:

- **`USER root` … `USER node`.** Global installs need root; the final image
  must not run as root.
- **Where `uv` puts tools.** `/root/.local` is mode 0700 and unreadable for uid
  1000. Set `UV_TOOL_DIR=/opt/uv-tools` and `UV_TOOL_BIN_DIR=/usr/local/bin`,
  and make the result world-readable.
- **Layer order.** Put the rarest-changing installs first; a `COPY` early in
  the file invalidates every layer below it on each rebuild.

Private packages that are not on a registry can be vendored as a tarball and
installed with `npm install -g ./package-1.0.0.tgz`.

## Monitoring

| Endpoint | Auth | Use |
|---|---|---|
| `/livez` | none | process liveness — this is what the image `HEALTHCHECK` calls |
| `/health` | Bearer | per-server state; `200` when all are up, `503` when any is not |

`/health` returns each server's `state`, its `restarts` counter, its tool count
and whether it is part of `/hub`:

```json
{
  "status": "degraded",
  "servers": {
    "paperless":     { "state": "up",   "restarts": 0, "tools": 14, "hub": true },
    "homeassistant": { "state": "down", "restarts": 3, "tools": 0,  "hub": true }
  }
}
```

A degraded child deliberately does **not** mark the container unhealthy —
restarting the whole hub would not fix one broken upstream.

::: tip Point external monitoring at /livez
`/health` needs a bearer token. An external monitor that polls it without one
gets a constant stream of 401s and, worse, tells you nothing.
:::

## Logging to a file {#fail2ban}

`LOG_FILE=/data/mcp-hub.log` mirrors every hub log line into that file with an
ISO-8601 UTC prefix, leaving console output untouched — `docker logs` keeps
working.

Only the hub's own lines are mirrored. The stdio children inherit `stderr`
directly, so their output stays in the container log and the file stays small.

::: details Why not read the container log instead
Two dead ends, both worth knowing about:

The Docker **`json-file`** path contains the container ID and changes on every
recreate, so a fail2ban jail pointed at it silently stops matching after the
next `docker compose up`.

The **`journald`** driver maps *all* stderr to priority `err`. An MCP server
must keep stdout free for the protocol and therefore logs everything —
including routine informational lines — to stderr. Every one of them then shows
up as a system error and drowns host-level error monitoring.
:::

Rotate the file with logrotate. `copytruncate` is required: the hub holds the
file open, so a renamed file would keep receiving writes.

```
/path/to/data/mcp-hub.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
```

### fail2ban jail

```ini
# /etc/fail2ban/filter.d/mcp-hub-auth.conf
[Definition]
failregex = mcp-hub: authentication failure from <HOST>\s*$
            mcp-hub: login rate limit exceeded from <HOST>\s*$
            mcp-hub: consent with an invalid CSRF token from <HOST>\s*$
ignoreregex =
```

```ini
# /etc/fail2ban/jail.d/mcp-hub.conf
[mcp-hub-auth]
enabled  = true
filter   = mcp-hub-auth
logpath  = /path/to/data/mcp-hub.log
maxretry = 5
findtime = 1h
bantime  = 24h
banaction = iptables-allports
```

::: warning Bans have to land in DOCKER-USER
When the hub is published through a container-based reverse proxy, that traffic
arrives via DNAT and traverses `FORWARD` — it never passes `INPUT`. A jail
writing to `INPUT` bans nothing. Use the `DOCKER-USER` chain.

Also check any *generic* 401 jail you run against the proxy's access log:
the MCP authorization flow produces legitimate 401 responses on every new
connection, and such a jail will happily ban your own clients. Exclude the
hub's vhost.
:::

## Revoking a client

Both commands mount the same `/data`. Stop the hub first so there is only one
writer:

```sh
docker compose stop mcp-hub
docker compose run --rm --no-deps mcp-hub node /app/dist/admin.js clients list
docker compose run --rm --no-deps mcp-hub node /app/dist/admin.js clients revoke CLIENT_ID
docker compose up -d
```

`clients list` prints each registered client with its registered and approved
redirect URIs and the time it was approved. `clients revoke` removes the
approval and every refresh token, and rejects already-issued access tokens
immediately. The next connection from that client needs explicit approval
again.

Installed from npm, the same commands are `mcp-hub-admin clients list` and
`mcp-hub-admin clients revoke <id>` with `DATA_PATH` pointing at the state
directory.
