import type { HubConfig } from '../config.js';

/** Canonical MCP resource identifiers use /hub or /<name>/mcp. */
export function canonicalResourceUrl(resource: URL, origin: string, config: HubConfig): URL | undefined {
  if (resource.origin !== origin || resource.username || resource.password || resource.search || resource.hash) return undefined;

  if (resource.pathname === '/hub' || resource.pathname === '/hub/mcp') return new URL('/hub', origin);

  const match = resource.pathname.match(/^\/([a-zA-Z0-9_-]+)(?:\/mcp)?$/);
  if (!match || !config.has(match[1])) return undefined;
  return new URL(`/${match[1]}/mcp`, origin);
}

/**
 * The form an operator approval records a resource in, and is looked up by:
 * canonical when a canonicaliser is available and the value parses, the raw
 * value otherwise. The issuer itself — the audience of an unbound token —
 * names no MCP route and is kept as it is.
 */
export function approvalResourceKey(resource: string, issuer: string, canonicalize?: (resource: URL) => URL | undefined): string {
  if (resource === issuer || !canonicalize) return resource;
  try {
    return canonicalize(new URL(resource))?.href ?? resource;
  } catch {
    return resource;
  }
}

export function resourceUrlForRoute(origin: string, name: string): URL {
  return new URL(name === 'hub' ? '/hub' : `/${name}/mcp`, origin);
}
