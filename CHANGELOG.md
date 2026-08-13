# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-14

### Changed

- **Breaking: access tokens are bound to one resource by default.**
  `RESOURCE_BOUND_TOKENS` no longer has to be switched on; RFC 8707 binding is
  what you get without asking, and the setting only exists to turn it *off*.
  A token issued for `/paperless/mcp` reaches neither another server nor `/hub`,
  and an authorization request that names no resource is refused with
  `invalid_target`.

  **Upgrading:** tokens issued before this release carry no resource and stop
  working, so every connector authorizes once more. To postpone that, set
  `RESOURCE_BOUND_TOKENS=false` — it restores the old behaviour and logs a
  warning on every start. The default also applies to `createHub()` for
  programmatic use.
- **Breaking: `/health` requires a token for `/hub`.** It reports the same
  fleet-wide view as the aggregate — every server's name, state and tool count —
  so a token bound to a single server no longer reads it. Unauthenticated
  liveness monitoring belongs on `/livez`, unchanged.
- The `uv` layer is pinned to a version tag (`0.12.3`) instead of `latest`. The
  digest is unchanged, so the image content is identical; upgrades now arrive as
  readable version bumps rather than opaque digest churn.
- The documentation site builds with VitePress 2. VitePress 1 pins Vite 5,
  which is end-of-life and carries unfixable dev-server advisories; Vite 8 clears
  them. Documentation tooling is not part of the published package or image.

### Added

- Documentation site at [mcp-hub.ni-c.de](https://mcp-hub.ni-c.de) — guides for
  configuration, deployment, clients and security, an architecture walkthrough,
  a troubleshooting FAQ and a full endpoint/meta-tool reference. Built with
  VitePress from `docs/`, which carries its own manifest so the runtime image
  and the test matrix are unaffected, and published to `gh-pages` by
  `.github/workflows/docs.yml`.

## [0.4.0] - 2026-08-13

### Added

- Published on npm as [`@ni-c/mcp-hub`](https://www.npmjs.com/package/@ni-c/mcp-hub)
  (the unscoped name belongs to an unrelated project). `npx @ni-c/mcp-hub`
  starts the hub, `mcp-hub-admin` ships as a second binary; Docker remains the
  recommended deployment. Releases are published via npm Trusted Publishing
  (OIDC, with provenance) from the new `release.yml`, which also creates the
  GitHub release from this changelog.

### Changed

- The version reported by the `/hub` server and the child MCP clients is now
  read from `package.json` instead of being hardcoded in two source files.
- zod updated to v4, the runtime image moved to `node:26-bookworm-slim`, and
  all GitHub Actions moved to their current majors (checkout v7, setup-node v7,
  CodeQL v4, docker/* v4/v6/v7, trivy-action 0.36).

### Fixed

- The `mcp-hub` binary was missing its shebang line, so the npm-installed
  command would not execute on Unix.

## [0.3.0] - 2026-08-13

Security-hardening release; deployment guidance moved to SECURITY.md.

### Security

- Resource-bound access tokens (RFC 8707), opt-in enforcement via
  `RESOURCE_BOUND_TOKENS=true`; access-token TTL down from 24 h to 15 min.
- Offline revocation via `mcp-hub-admin clients list|revoke`
  (`revokedBefore` marker); stricter EdDSA-pinned JWT verification.
- Per-IP rate limits on all auth endpoints before body parsing, a per-client
  request/concurrency gate for MCP traffic, 1 MB body limit after bearer auth,
  server header/request timeouts and browser hardening (CSP, frame denial) on
  the interactive pages.
- `/health` moved behind bearer auth; new unauthenticated `/livez` liveness
  probe (also used by the image `HEALTHCHECK`).

### Supply chain

- Digest-/SHA-pinned base images and Actions, CodeQL + Trivy gates before
  publishing, SBOM and `mode=max` provenance on images, Dependabot for npm,
  Docker and Actions; bundled npm replaced with npm 12 and its two remaining
  vendored CVEs patched in place; `tini` as PID 1, `curl` removed,
  read-only-rootfs compose example.

## [0.2.0] - 2026-08-11

### Added

- `LOG_FILE` mirrors every hub log line into a file with an ISO-8601 UTC
  prefix while leaving the console untouched — a stable path for fail2ban and
  friends (the Docker `json-file` path changes on every recreate and the
  `journald` driver maps all stderr to priority `err`).

## [0.1.0] - 2026-08-11

First public release: serve many stdio MCP servers from one container over
Streamable HTTP — Claude-Code-style `mcpServers` config (1:1 copy), path-based
routing (`/<name>`, `/<name>/mcp`), the `/hub` aggregate with four meta-tools,
a built-in OAuth 2.1 authorization server (DCR, PKCE, per-client approval,
rotating refresh tokens), child supervision with backoff restarts, config hot
reload, native remote `http`/`sse` upstreams and multi-arch images on GHCR.
