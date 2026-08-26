# Try it locally

Before wiring up a real server, a hostname and a certificate, you can run a
throwaway hub with three fake MCP servers and point an inspector at it. It
takes one command and shows the parts that are hard to picture from a config
file: the `/hub` aggregate, per-server endpoints, resource-bound tokens and
idle sleep.

The setup lives in [`demo/`](https://github.com/ni-c/mcp-hub/tree/main/demo)
in the repository.

```sh
git clone https://github.com/ni-c/mcp-hub.git
cd mcp-hub/demo
docker compose up -d
curl -s localhost:7690/livez
```

The hub is now on <http://localhost:7690>, the login password is `demo`, and
three servers are configured:

| Endpoint | Tools |
|---|---|
| `/weather/mcp` | `list_stations`, `get_forecast` |
| `/tickets/mcp` | `list_tickets`, `get_ticket`, `create_ticket`, `list_statuses` |
| `/docs/mcp` | `search_docs`, `read_doc`, `list_docs` |
| `/hub` | all three at once, through six meta-tools |

They answer from tables compiled into them — no network, no filesystem, no
stored state — so the same call gives the same answer every time, and nothing
a visitor does outlasts the request.

::: warning Not a deployment template
The demo publishes its password, speaks plain HTTP, sleeps servers after a
minute and keeps state in a volume nobody backs up. For a real host use
[`docker-compose.example.yml`](https://github.com/ni-c/mcp-hub/blob/main/docker-compose.example.yml)
and the [deployment guide](/guide/deployment).
:::

## MCP Inspector

Start the [inspector](https://github.com/modelcontextprotocol/inspector) and
leave it running:

```sh
npx @modelcontextprotocol/inspector
```

Then open the pre-filled link:

<http://localhost:6274/?transport=http&serverUrl=http://localhost:7690/hub>

The `serverUrl` and `transport` parameters fill the connection form; pressing
**Connect** is still yours to do, because the inspector auto-connects only for
a link that carries its own session token — which a link in a document cannot
know. Replace `/hub` with `/weather/mcp` to connect to one server instead of
the aggregate.

For authorization, either let the inspector run the OAuth flow (the password
is `demo`) or paste a bearer token from `./token.sh hub` into the
Authentication field.

## MCPJam

```sh
npx @mcpjam/inspector@latest
```

Add a server, set the connection type to **HTTP** and enter
`http://localhost:7690/hub`. Authorization is the same choice: OAuth with the
password `demo`, or a token from `./token.sh hub`.

The hosted app at [app.mcpjam.com](https://app.mcpjam.com) cannot reach this
demo. It connects to HTTPS endpoints only, and the demo is plain HTTP on
localhost — use the local inspector above or the desktop app.

## Tokens

`demo/token.sh` mints API tokens through the [admin CLI](/reference/admin-cli):

```sh
./token.sh            # a token for /hub
./token.sh weather    # a token for /weather/mcp
./token.sh --all      # one per resource
```

Tokens are [bound to one resource](/guide/security), which is easy to see
here: a `hub` token gets a `401` from `/weather/mcp`. That is the default
behaviour, not a misconfiguration.

## What to look for

- **The aggregate versus one server.** Connected to `/hub`, a client carries
  six tool schemas — `list_servers`, `list_tools`, `get_tool_schema`,
  `call_tool`, `wake_server`, `sleep_server` — and reaches nine tools through
  them. Connected to `/tickets/mcp` it sees that one server, natively. See
  [architecture](/guide/architecture).
- **Idle sleep.** The demo sets `IDLE_TIMEOUT_MINUTES=1`, so you can watch it
  happen: leave a server alone for a minute or two — the sweep for idle
  servers runs once a minute, so it is not to the second — and `list_servers`
  reports it as `sleeping`. `list_tools` keeps answering from the tool cache,
  and the next `call_tool` wakes the server without the client noticing.
  `weather` is configured `"keepAlive": true` and stays up. See
  [on-demand servers](/guide/on-demand).
- **Hot reload.** Edit `config/mcp.json` while the hub runs — no restart. See
  [configuration](/guide/configuration#hot-reload).
- **`/health`.** State, restart count and tool count per server.

## Clean up

```sh
docker compose down -v
```

`-v` removes the data volume with its tokens and client registrations, so the
next start is a blank slate.
