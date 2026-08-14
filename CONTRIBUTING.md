# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/mcp-hub.git && cd mcp-hub
npm install
npm test          # vitest: config, OAuth flow, proxy E2E, hub, hot reload, API tokens
npm run dev       # tsx; needs EXTERNAL_URL, PASSWORD, CONFIG_PATH, DATA_PATH
```

A minimal dev environment:

```sh
echo '{"mcpServers":{}}' > /tmp/mcp.json
EXTERNAL_URL=http://localhost:3000 PASSWORD=dev \
  CONFIG_PATH=/tmp/mcp.json DATA_PATH=/tmp/mcp-hub-data npm run dev
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  The suite is fast (~2 s) — run it before pushing. CI runs it on Node 20 and
  22, plus CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next
  line does.
- **Security-sensitive areas** (`src/auth/*`): please describe the attack you
  are defending against, or the one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is
  a feature.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/mcp-hub/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/mcp-hub/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/mcp-hub/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
