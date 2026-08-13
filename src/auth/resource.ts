import type { HubConfig } from '../config.js';

/** Canonical MCP resource identifiers use /hub or /<name>/mcp. */
export function canonicalResourceUrl(resource: URL, origin: string, config: HubConfig): URL | undefined {
  if (resource.origin !== origin || resource.username || resource.password || resource.search || resource.hash) return undefined;

  if (resource.pathname === '/hub' || resource.pathname === '/hub/mcp') return new URL('/hub', origin);

  const match = resource.pathname.match(/^\/([a-zA-Z0-9_-]+)(?:\/mcp)?$/);
  if (!match || !config.has(match[1])) return undefined;
  return new URL(`/${match[1]}/mcp`, origin);
}

export function resourceUrlForRoute(origin: string, name: string): URL {
  return new URL(name === 'hub' ? '/hub' : `/${name}/mcp`, origin);
}
