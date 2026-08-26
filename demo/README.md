# Try mcp-hub locally

A throwaway hub with three fake MCP servers, so you can see what a client sees
before wiring up anything real. No reverse proxy, no certificates, no
credentials to invent.

```sh
docker compose up -d
curl -s localhost:7690/livez
```

That is the whole setup. The hub is on <http://localhost:7690>, the login
password is `demo`, and the three servers are:

| Endpoint | Tools |
|---|---|
| `/weather/mcp` | `list_stations`, `get_forecast` |
| `/tickets/mcp` | `list_tickets`, `get_ticket`, `create_ticket`, `list_statuses` |
| `/docs/mcp` | `search_docs`, `read_doc`, `list_docs` |
| `/hub` | all three at once, through six meta-tools |

They answer from tables compiled into them: no network, no filesystem, no
stored state. `create_ticket` accepts a ticket, acknowledges it and throws it
away — the backlog is the same for everyone, on purpose.

## Connect the MCP Inspector

Start it, leave it running, and open the pre-filled link:

```sh
npx @modelcontextprotocol/inspector
```

<http://localhost:6274/?transport=http&serverUrl=http://localhost:7690/hub>

`serverUrl` and `transport` fill the connection form; you still press
**Connect**, because the inspector only auto-connects for a link carrying its
session token, which a link written down here cannot know. Swap `/hub` for
`/weather/mcp` to connect to a single server instead.

Then authorize, either way:

- **OAuth** — press Connect and the inspector runs the flow itself. The
  password is `demo`.
- **Bearer token** — `./token.sh hub` prints one; paste it under
  Authentication.

## Connect MCPJam

```sh
npx @mcpjam/inspector@latest
```

Add a server, choose connection type **HTTP**, and enter
`http://localhost:7690/hub`. Authorization works the same way: let it run
OAuth with the password `demo`, or paste a token from `./token.sh hub`.

The hosted app at [app.mcpjam.com](https://app.mcpjam.com) **cannot** reach
this demo — it only connects to HTTPS endpoints, and this one is plain HTTP on
localhost. Use the local inspector above, or the desktop app.

## Or just curl it

```sh
TOKEN=$(./token.sh hub)
curl -s localhost:7690/hub \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}'
```

`./token.sh` takes the resource as its argument (`hub` by default,
`--all` for one of each). Tokens are bound to one resource, so a `hub` token
gets a `401` from `/weather/mcp` — that is the feature working, not a bug.
`./token.sh weather` is the token for that endpoint.

## What is worth looking at

- **`/hub` versus the individual endpoints.** Connected to `/hub`, a client
  carries six tool schemas — `list_servers`, `list_tools`, `get_tool_schema`,
  `call_tool`, `wake_server`, `sleep_server` — and reaches nine tools through
  them. Connected to `/tickets/mcp`, it sees that server and nothing else.
- **Idle sleep.** This demo sleeps servers after one minute instead of the
  default hour. Leave one alone for a minute or two — the hub sweeps for idle
  servers once a minute, so it is not to the second — and `list_servers`
  reports it as `sleeping`. `list_tools` still answers, from the tool cache,
  and the next `call_tool` wakes the server transparently. `weather` is
  configured `keepAlive` and stays up — that is the contrast.
- **`/health`.** Per-server state, restart count and tool count.
- **Hot reload.** Edit `config/mcp.json` while the hub runs; it is picked up
  without a restart.

## Stop it

```sh
docker compose down -v
```

`-v` drops the data volume, which is where tokens and client registrations
live — the next start is a blank slate.

## This is not a deployment template

Use
[`docker-compose.example.yml`](../docker-compose.example.yml) for that, and
read [the deployment guide](https://mcp-hub.ni-c.de/guide/deployment). Four
things here are deliberately wrong for a real host: a password published in a
file, plain HTTP, a one-minute idle timeout, and state in a volume nobody
backs up.

## Demoing the working tree

`compose.yml` builds on the published image. To run the code in your checkout
instead, build it first and point the demo at it:

```sh
docker build -t mcp-hub:local ..
MCP_HUB_IMAGE=mcp-hub:local docker compose up -d --build
```
