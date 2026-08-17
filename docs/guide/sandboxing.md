# Sandboxing untrusted servers

A stdio server configured in `mcp.json` runs inside the hub's container, as the
hub's user. It can read `/data/jwt-key.pem`, the state file with every OAuth
client, `/proc/1/environ` with every other server's credentials, and whatever
the network policy allows. That is fine for code you wrote or read. It is not
fine for the interesting half of the MCP ecosystem.

The usual answer is to run such a server elsewhere and connect it as a
[remote HTTP server](/guide/configuration#remote-servers). It works, but it
asks a lot of a program that only speaks stdio: an HTTP listener, a bearer
token you now have to store in two places, membership in a shared network, and
— if the server has no HTTP mode at all — a bridge process inside the image,
which is one more piece of unreviewed code at exactly the trust boundary you
were trying to draw.

mcp-hub offers two ways to keep the isolation and drop the HTTP:

| | [`type: "docker"`](#docker-servers) | [`type: "unix"` / `"tcp"`](#socket-servers) |
|---|---|---|
| Who starts the container | the hub | you, in Compose |
| What the hub needs | a socket to the [policy proxy](#the-policy-proxy) | nothing |
| What the image needs | nothing | a one-line shim (`socat`) |
| Configuration lives in | `mcp.json` | `mcp.json` + your Compose file |

Both carry the same protocol: newline-delimited JSON-RPC, the framing the
[specification asks custom transports to reuse](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
when they run over a byte stream rather than a pipe. No adapter, no
translation, no second dialect.

## Docker servers

```json
"eve": {
  "type": "docker",
  "image": "eve-mcp:local",
  "command": ["python3", "esi.py"],
  "env": { "HOME": "/data" },
  "secretsFrom": "eve",
  "volumes": ["/srv/eve/data:/data"],
  "ports": ["127.0.0.1:8686:8000"],
  "network": "eve-net",
  "memory": "384m",
  "pidsLimit": 128
}
```

The hub creates that container, attaches to its stdin and stdout, starts it,
and talks MCP across the boundary. When the server dies the container is
removed and the supervisor restarts it with the usual backoff; when the entry
changes, the container is replaced.

| Field | Default | Notes |
|---|---|---|
| `image` | *(required)* | Tag or digest. Must exist locally unless `pull` says otherwise. |
| `pull` | `never` | `missing` lets the hub fetch the image. `never` fails loudly instead of running whatever a registry serves today. |
| `command` / `entrypoint` | *(image default)* | Arrays of strings, like Docker's `Cmd`/`Entrypoint`. |
| `env` | `{}` | Passed to the container only. `${VAR}` is expanded from the hub's environment. |
| `secretsFrom` | *(none)* | Name of an env file the **proxy** holds — see [secrets](#secrets-the-hub-never-sees). |
| `volumes` | `[]` | `source:/target[:ro]`. Source is an absolute host path or a named volume. |
| `ports` | `[]` | `[ip:]hostPort:containerPort[/proto]`. An omitted address means `127.0.0.1`, not every interface. |
| `network` | `none` | Docker network name. `none` means no interface at all — still reachable, because the protocol does not use the network. |
| `memory`, `pidsLimit` | *(unset)* | `"384m"`, `"1g"` or a byte count. |
| `readOnly` | `true` | Read-only root filesystem. |
| `tmpfs` | `["/tmp"]` | `"/path"` or `"/path:options"`. |
| `user` | *(image default)* | `"1000:1000"` or a name. |

Every container is created with all capabilities dropped, `no-new-privileges`,
`Privileged: false`, no restart policy and `AutoRemove`. None of that is
configurable: a knob that can only weaken the sandbox is a knob the policy
would have to defend.

::: tip Only `env` values may use `${VAR}`
Everything else — the image, mounts, ports, network, user, command — must be
written out literally. The proxy validates those fields against this file and
holds none of your secrets, so a variable there would be a field it could not
check. That is exactly the field an attacker would pick.
:::

### Three things worth knowing

**stdout belongs to the protocol.** A server that prints to stdout under stdio
corrupts the stream — the hub logs `not JSON` and drops that message. Logging
must go to stderr, where the hub prefixes it `[name]` and passes it through to
its own stderr, just like a stdio child's.

**The container is recreated on every hub start.** A server with a long startup
pays it again after a hub restart. The hub answers `503` on that server's path
meanwhile; nothing else waits for it.

**One Docker host, one hub.** Sandbox containers are named `mcp-sandbox-<server>`
and labelled `io.mcp-hub.owner=mcp-hub`, and on startup the hub removes owned
containers that its configuration no longer mentions. Two hubs sharing a daemon
would therefore fight over the namespace and reap each other's sandboxes. If you
run two (a test instance beside a live one, say), give them separate Docker
hosts — or keep `type: "docker"` in one of them and use
[socket servers](#socket-servers) in the other.

## The policy proxy

Creating containers means talking to the Docker daemon, and the daemon's API is
root: one `POST /containers/create` with `Privileged: true` or a `/:/host` bind
owns the machine. The hub is the internet-facing component. It must not have
that socket.

So it does not get it. `mcp-hub-docker-proxy` is a second, much smaller image
that holds the daemon socket and exposes a Unix socket to the hub. It reads the
same `mcp.json` — read-only, owned by the host — and allows exactly the
container operations that file describes.

```
┌─────────┐  unix socket   ┌──────────────┐  /var/run/    ┌────────┐
│ mcp-hub │───────────────▶│ docker-proxy │──docker.sock─▶│dockerd │
│ no sock │                │ policy from  │               └───┬────┘
└─────────┘                │   mcp.json   │                   │
     ▲                     └──────────────┘          ┌────────▼────────┐
     └────────── stdio over the attach stream ───────│ mcp-sandbox-eve │
                                                     └─────────────────┘
```

What it enforces:

- The container name must be `mcp-sandbox-<server>`, and `<server>` must be a
  `type: "docker"` entry in the config.
- The whole create request must match the one derived from that entry —
  image, mounts, ports, limits, flags. It is compared against a request rebuilt
  by the very function the hub used to build it, so the policy cannot drift
  from the code that sends the request.
- `Env` is compared by **key**. Values belong to the hub; the proxy neither
  needs nor wants them.
- Refused regardless of the config: `Privileged`, `CapAdd`, `Devices`,
  `Mounts`, host namespaces, joining another container's network, and any bind
  under `/`, `/proc`, `/sys`, `/dev`, `/etc`, `/boot`, `/root`, `/run`,
  `/var/run` or `/var/lib/docker`.
- Allowed endpoints: `_ping`, `version`, container create/start/stop/wait/
  attach/remove within the `mcp-sandbox-` namespace, a label-filtered container
  list, image inspection, and `images/create` only for an entry that asked for
  `"pull": "missing"`. Everything else is `403`.

Nothing is forwarded verbatim. Every allowed request is rebuilt — method, path,
query, body — from the decision, so a duplicate query parameter, an extra JSON
key or a second `Content-Length` has nothing to ride on.

What survives a fully compromised hub, then, is the ability to run exactly the
containers `mcp.json` describes. Not a privileged one, not one with the host
filesystem mounted, not one built from another image.

### Compose

```yaml
services:
  docker-proxy:
    image: ghcr.io/ni-c/mcp-hub-docker-proxy:0.7.0
    container_name: mcp-hub-docker-proxy
    restart: unless-stopped
    # Access to the socket comes from the group, not from running as root.
    group_add: ["<gid of the docker group>"]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    volumes:
      - "./mcp.json:/config/mcp.json:ro"
      - "./secrets:/run/secrets:ro"
      - "/var/run/docker.sock:/var/run/docker.sock"
      - "proxy-sock:/run/proxy"

  mcp-hub:
    image: ghcr.io/ni-c/mcp-hub:0.7.0
    depends_on: [docker-proxy]
    environment:
      DOCKER_HOST: "unix:///run/proxy/docker.sock"
    volumes:
      - "./mcp.json:/config/mcp.json:ro"
      - "./data:/data"
      - "proxy-sock:/run/proxy"

volumes:
  proxy-sock:
```

Run the two at the same version. They read the same file with the same parser,
and they are published from the same pipeline under the same tags for that
reason.

Find the group id with `getent group docker`. Both containers must agree on the
socket volume; nothing else is shared between them.

### Secrets the hub never sees

A sandboxed server usually needs credentials, and passing them through the hub
would put them back in the process every stdio child can read. So it does not
have to:

```json
"eve": { "type": "docker", "image": "eve-mcp:local", "secretsFrom": "eve" }
```

```
secrets/eve.env      # chmod 640, mounted into the proxy only
  EVE_CLIENT_ID=...
  EVE_CLIENT_SECRET=...
```

The proxy appends those variables to the create request **after** it has
validated it. The hub's `mcp.json` names the file, never its contents; the hub
process never holds the values. A world-readable secret file is refused, and a
key that collides with one of the entry's own `env` keys is refused too —
silently letting one win would leave you unsure which value the container got.

## Socket servers

If you would rather not give any component the Docker socket, run the container
yourself and let the hub connect to a socket:

```json
"scary": { "type": "unix", "socket": "/run/mcp/scary.sock" },
"remote-sandbox": { "type": "tcp", "host": "sandbox-host", "port": 9000 }
```

```yaml
  scary-mcp:
    image: ghcr.io/example/scary-mcp:1.2.3
    command: socat UNIX-LISTEN:/run/mcp/scary.sock,fork,mode=0660 EXEC:"scary-mcp"
    user: "1000:1000"          # same uid as the hub, so it may open the socket
    network_mode: none          # possible precisely because there is no HTTP
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    volumes: ["mcp-sockets:/run/mcp"]
    environment:
      SCARY_TOKEN: "${SCARY_TOKEN}"   # the hub never learns this either
```

The shim is whatever pipes a socket to a process — `socat` is one line, and any
image that has a shell and a static helper will do. The hub connects, retries
with backoff if the socket is not there yet, and treats the server exactly like
any other.

`network_mode: none` is worth pausing on: an HTTP upstream can never have it,
because HTTP needs an interface to listen on. A server that has no business
reaching the network can be given no network at all and still be a first-class
MCP server here.

## Which one to use

Use `type: "docker"` when you want the sandbox described in one file, next to
the server it belongs to, and you are willing to run the proxy.

Use `type: "unix"` when you want no component to hold the Docker socket, when
the sandbox is managed by something other than this hub, or when it lives on
another host (`type: "tcp"`).

Use a remote HTTP server when the upstream is genuinely a network service that
happens to speak MCP.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `image "x" is not present and "pull" is "never"` | Build or pull it, or set `"pull": "missing"`. |
| `403 … create request does not match the configuration — .HostConfig.Memory` | The proxy is running an older `mcp.json` than the hub. Both poll the file; it resolves itself on the next retry, within seconds. |
| `403 … is not a docker server in the configuration` | The proxy cannot see the config the hub sees — check that both mount the same `mcp.json`. |
| `connect EACCES /run/proxy/docker.sock` | The socket volume is not shared with the hub, or the proxy's `SOCKET_MODE`/uid does not let it in. |
| `permission denied … /var/run/docker.sock` in the proxy | `group_add` is missing or has the wrong gid. |
| Server flaps `up` / `down (container exited)` | The server exits on its own. Its stderr is in the hub's log, prefixed with the server name. |
| Handshake never completes, log shows `not JSON` | The server writes to stdout. Under stdio that is the protocol channel. |
