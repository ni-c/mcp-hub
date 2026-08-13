# Comparison

mcp-hub solves one specific problem: **publishing stdio MCP servers to hosted
clients over HTTPS, with OAuth, without one container per server.** Plenty of
setups do not have that problem. This page is about telling them apart.

## Running servers locally in the client

Claude Code and Claude Desktop launch stdio servers themselves from a local
config. Nothing is exposed, nothing needs a certificate, and the server can
touch your local filesystem.

**Stay with this if** every client you use runs on the machine that should run
the servers.

**You outgrow it when** you want the same servers from Claude Web, from a
phone, or from more than one machine — none of which can start a process on
your desktop.

## `mcp-remote`

[`mcp-remote`](https://github.com/geelen/mcp-remote) is a stdio bridge that
lets a *local* client talk to a *remote* MCP server, handling the OAuth flow in
a browser and caching the tokens.

It points the opposite way from mcp-hub: it adapts remote servers for local
clients; mcp-hub adapts local servers for remote clients. They are
complementary, not alternatives — mcp-hub can even run `mcp-remote` as one of
its stdio children to reach an upstream whose OAuth needs a browser
([how](/guide/configuration#upstreams-with-interactive-oauth)).

**Use `mcp-remote` if** your servers are already remote and your clients are
local.

## One auth proxy per server

Wrap each stdio server in its own container with an OAuth or
forward-auth proxy in front, one hostname each.

**This is genuinely better when** your servers have *different* trust levels.
Separate containers give separate filesystems, separate credentials and
separate network policy. mcp-hub deliberately does not: every stdio child
shares the hub's user and can read its state directory. That is the central
trade-off, and it is why [SECURITY.md](/guide/security#trust-model) says to put
untrusted servers elsewhere and connect them as remote upstreams.

**mcp-hub is better when** you trust the servers and are paying N× for images,
certificates, OAuth stacks, log streams and re-authorizations that give you
nothing extra.

You do not have to choose globally: run the sensitive ones separately and add
them to the hub as `type: "http"` entries. From the client's side it is one
setup either way.

## Servers that already speak HTTP

A growing number of MCP servers ship their own Streamable-HTTP endpoint and
their own authentication.

**You do not need a gateway for those.** Point the client straight at them.

Two reasons people still route them through mcp-hub:

- **One connector.** Adding them to `/hub` keeps the client's connector list
  and its context small.
- **One authentication story.** The hub holds the upstream credential in a
  header and presents its own OAuth outward, so a client never sees the
  upstream's token — and an expired upstream credential shows up as one server
  `down` in `/health` instead of a confusing 401 in the client.

## Hosted or commercial MCP gateways

Managed gateways add things a single container does not have: multiple users
and roles, audit trails, policy engines, SSO against a company directory,
per-tool authorization.

**Choose one of those if** you need any of that. mcp-hub has exactly one
password and no notion of who is using it. It is built for one person or a
small trusted group running their own infrastructure.

## Summary

| | Local stdio | `mcp-remote` | Proxy per server | mcp-hub |
|---|---|---|---|---|
| Reachable from hosted clients | no | n/a | yes | yes |
| Containers to operate | none | none | N | 1 |
| Certificates / hostnames | none | none | N | 1 |
| Logins to maintain | none | per server | N | 1 |
| Isolation between servers | n/a | n/a | **strong** | none (same user) |
| Context cost for N servers | N × tools | N × tools | N × tools | 4 meta-tools via `/hub` |
| Multi-user, roles, audit | no | no | depends | no |

If the isolation row is the one that matters for your setup, use separate
containers — and let mcp-hub aggregate them over HTTP.
