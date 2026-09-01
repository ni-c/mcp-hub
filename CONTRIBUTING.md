# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/mcp-hub.git && cd mcp-hub
npm install
npm test          # vitest: config, OAuth flow, proxy, hub, hot reload, API tokens
npm run dev       # tsx; needs EXTERNAL_URL, PASSWORD, CONFIG_PATH, DATA_PATH
```

There is a second suite that runs the hub as a real process and as the
published image. It is not part of `npm test` and does not need to be run
before every push:

```sh
npm run build                                    # the spawned tiers execute dist/
MCPHUB_E2E_TIERS=inproc,process npm run test:e2e
```

What it is for, and why it is separate, is in [`e2e/README.md`](e2e/README.md).
Run it when you touch `src/index.ts`, `src/supervisor.ts`, `src/auth/store.ts`,
`src/limits.ts`, the Dockerfiles or `demo/` — those are the places where "it
works in-process" and "it works" are different claims.

A minimal dev environment:

```sh
echo '{"mcpServers":{}}' > /tmp/mcp.json
EXTERNAL_URL=http://localhost:3000 PASSWORD=dev \
  CONFIG_PATH=/tmp/mcp.json DATA_PATH=/tmp/mcp-hub-data npm run dev
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  The fast suite runs in a few seconds — run it before pushing. CI runs it on
  Node 22 and 24, plus CodeQL and a Trivy scan of both container images. The
  end-to-end suite runs nightly, on any pull request that touches `e2e/` or
  `demo/`, and as a gate on release tags.
- **Nothing sleeps in a test.** Wait for a condition with a deadline, never for
  a duration. Timing constants live in `src/timings.ts` so that behaviour which
  takes a minute in production can be *configured* short rather than waited out;
  a suite that sleeps is a suite somebody deletes.
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
