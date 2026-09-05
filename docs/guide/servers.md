# Servers to run behind it

mcp-hub is server-agnostic: it serves any stdio MCP server whose entry fits
Claude Code's `mcpServers` format, which is most of them, plus remote upstreams
over Streamable HTTP. Nothing on this page is required — it is a starting point
for a config file.

The eighteen below are built and maintained alongside the hub. Their
documentation carries the hub entry you need, their tool filters line up with the
hub's own `allowTools` / `denyTools`, and each of them speaks both protocol
revisions, so the elicitation the hub forwards reaches a person rather than
stopping at a server that only knows the older one.

| Server                                                                 | npm                               | What it reaches                                                                |
| ---------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| [audiobookshelf-mcp](https://audiobookshelf-mcp.ni-c.de)               | `audiobookshelf-mcp`              | Audiobookshelf — libraries, listening progress, collections and playlists      |
| [caldav-mcp](https://caldav-mcp.ni-c.de)                               | `@ni-c/caldav-mcp`                | CalDAV — events, tasks and journal entries on any server that speaks it        |
| [calibreweb-mcp](https://calibreweb-mcp.ni-c.de)                       | `calibreweb-mcp`                  | Calibre-Web — read-only library access through the OPDS feed                   |
| [freshrss-mcp](https://freshrss-mcp.ni-c.de)                           | `@ni-c/freshrss-mcp`              | FreshRSS — feeds, categories and articles as plain text, not stream ids        |
| [google-search-console-mcp](https://google-search-console-mcp.ni-c.de) | `@ni-c/google-search-console-mcp` | Google Search Console — properties, sitemaps, search analytics, URL inspection |
| [healthchecks-mcp](https://healthchecks-mcp.ni-c.de)                   | `healthchecks-mcp`                | Healthchecks — cron and uptime checks, and why one failed                      |
| [hetzner-dns-mcp](https://hetzner-dns-mcp.ni-c.de)                     | `hetzner-dns-mcp`                 | Hetzner Cloud DNS — zones, record sets and BIND import/export                  |
| [imap-mcp](https://imap-mcp.ni-c.de)                                   | `@ni-c/imap-mcp`                  | IMAP mailboxes — read, search, organise and draft mail; it cannot send         |
| [linkwarden-mcp](https://linkwarden-mcp.ni-c.de)                       | `linkwarden-mcp`                  | Linkwarden — bookmarks, collections and the article text it preserved          |
| [mealie-mcp](https://mealie-mcp.ni-c.de)                               | `@ni-c/mealie-mcp`                | Mealie — recipes, meal plans, shopping lists and cookbooks                     |
| [ntfy-mcp](https://ntfy-mcp.ni-c.de)                                   | `@ni-c/ntfy-mcp`                  | ntfy — publish and update notifications, manage users and topic access         |
| [opengist-mcp](https://opengist-mcp.ni-c.de)                           | `opengist-mcp`                    | Opengist — gists, revisions, commit history and raw files                      |
| [osm-mcp](https://osm-mcp.ni-c.de)                                     | `osm-mcp`                         | OpenStreetMap — geocoding, routing, isochrones and POI search                  |
| [rustpad-mcp](https://rustpad-mcp.ni-c.de)                             | `rustpad-mcp`                     | Rustpad — collaborative pads edited through real OT, not overwrites            |
| [smtp-mcp](https://smtp-mcp.ni-c.de)                                   | `@ni-c/smtp-mcp`                  | SMTP — sends mail, behind a recipient allowlist and a human confirmation       |
| [wg-easy-mcp](https://wg-easy-mcp.ni-c.de)                             | `wg-easy-mcp`                     | wg-easy v15+ — the full WireGuard client lifecycle                             |
| [wikijs-mcp](https://wikijs-mcp.ni-c.de)                               | `@ni-c/wikijs-mcp`                | Wiki.js — search, read and edit pages, plus assets, users and groups           |
| [woodpecker-ci-mcp](https://woodpecker-ci-mcp.ni-c.de)                 | `@ni-c/woodpecker-ci-mcp`         | Woodpecker CI — repositories, pipelines, logs, secrets and crons               |

## Adding one

Every entry is the one you already have in Claude Code, dropped into the hub's
`/config/mcp.json`:

```json
{
  "mcpServers": {
    "wikijs": {
      "command": "npx",
      "args": ["-y", "@ni-c/wikijs-mcp"],
      "env": {
        "WIKIJS_URL": "https://wiki.example.com",
        "WIKIJS_TOKEN": "…"
      },
      "denyTools": ["delete_*"]
    }
  }
}
```

It is then reachable at `https://your-host/wikijs`, and through the `/hub`
aggregate alongside every other server. See [Configuration](/guide/configuration)
for the fields the hub adds on top of Claude Code's, and
[Connecting clients](/guide/clients) for the client end.
