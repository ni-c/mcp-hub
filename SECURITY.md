# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/mcp-hub/security/advisories/new). Do not open a public issue for an unpatched vulnerability and do not include real credentials, tokens, hostnames or private configuration in a report.

Only the latest release and the current `main` branch receive security fixes.

## Trust model

mcp-hub is an authorization gateway, not a sandbox for MCP servers. Every configured stdio server runs as the same operating-system user as the hub. It can therefore access the hub's mounted files and process environment, including OAuth state and credentials, and can attempt network access allowed to the container. Only run fully trusted stdio packages in the hub container.

Untrusted or differently trusted servers must run in separate containers or hosts with their own filesystem, credentials and network policy. Connect them to mcp-hub as remote HTTP/SSE servers.

Avoid `npx -y`, unversioned `uvx`, mutable Git branches and other runtime downloads. Install reviewed, exactly versioned server packages while building a custom image, scan that image, and keep the runtime root filesystem read-only.

## Deployment requirements

- Terminate TLS at a trusted reverse proxy and set `EXTERNAL_URL` to the exact public HTTPS origin.
- Set `TRUSTED_PROXIES` only to proxy addresses that overwrite forwarded headers.
- Use `PASSWORD_HASH`, a persistent private `/data` volume, and `RESOURCE_BOUND_TOKENS=true`.
- Keep the example's non-root user, dropped capabilities, read-only root filesystem, process/RAM limits and `no-new-privileges` setting.
- Treat `/data/jwt-key.pem`, `/data/state.json`, the MCP config and all referenced environment variables as secrets.
- Restrict outbound network access to the destinations required by configured servers.

Access tokens expire after 15 minutes. Refresh tokens rotate, and reuse of a consumed token revokes its family. Use the offline admin command documented in the README to revoke all grants for a client immediately.
