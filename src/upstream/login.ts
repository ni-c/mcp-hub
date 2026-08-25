import type { AuthStore, UpstreamCredentials } from '../auth/store.js';
import { signPayload } from '../auth/signed-token.js';
import type { HubConfig, RemoteServerConfig } from '../config.js';
import { UpstreamAuth } from './auth.js';
import type { UpstreamState } from './routes.js';

/**
 * The operator-facing half of outbound OAuth, shared by the admin CLI and — for
 * the parts that need it — the callback route.
 *
 * Deliberately free of Express and of `process.exit`, so `admin.ts` stays what
 * it is elsewhere: argument parsing and printing. That also keeps this file
 * inside the coverage gate, which excludes `admin.ts`.
 */

/** Long enough for a sign-in with MFA and a consent screen, short enough that an
 *  abandoned attempt does not linger. */
export const LOGIN_TTL_MS = 15 * 60_000;

export class UpstreamCommandError extends Error {}

/** The remote server with this name, or a clear reason why it cannot be used. */
export function requireOAuthServer(config: HubConfig, name: string): RemoteServerConfig {
  const server = config.get(name);
  if (!server) throw new UpstreamCommandError(`Unknown server: ${name}`);
  if (server.kind !== 'remote') throw new UpstreamCommandError(`Server "${name}" is not a remote server`);
  if (!server.oauth) throw new UpstreamCommandError(`Server "${name}" has no "oauth" block in mcp.json`);
  return server;
}

export function authFor(store: AuthStore, externalUrl: string, name: string, server: RemoteServerConfig): UpstreamAuth {
  return new UpstreamAuth(name, server, store, externalUrl);
}

/**
 * Starts an interactive login and returns the URL the operator has to open.
 *
 * The `state` is signed with the same secret the hub's own browser tokens use,
 * so the callback can trust which server a redirect belongs to without taking
 * the server name from the query string.
 */
export async function startUpstreamLogin(
  store: AuthStore,
  auth: UpstreamAuth
): Promise<{ authorizationUrl: string; expiresAt: number }> {
  if (auth.identity.oauth.grant !== 'authorization_code') {
    throw new UpstreamCommandError(
      `Server "${auth.identity.serverName}" uses the ${auth.identity.oauth.grant} grant, which needs no browser. Use "upstream refresh" instead.`
    );
  }
  const expiresAt = Date.now() + LOGIN_TTL_MS;
  const payload: UpstreamState = { n: auth.identity.serverName, exp: expiresAt };
  const state = signPayload(payload, store.cookieSecret);
  const { authorizationUrl, login } = await auth.startLogin(state);
  store.saveUpstreamLogin(state, { ...login, expiresAt: Math.floor(expiresAt / 1000) });
  return { authorizationUrl, expiresAt };
}

export interface UpstreamStatus {
  server: string;
  mode: string;
  grant: string;
  scopes: string[];
  state: 'authorized' | 'expired' | 'login_required' | 'stale';
  clientId?: string;
  registered: boolean;
  hasRefreshToken: boolean;
  accessTokenValidUntil?: string;
  obtainedAt?: string;
  loginPending: boolean;
}

/** What `upstream list`/`status` prints. Reads only — never starts anything. */
export function upstreamStatus(store: AuthStore, config: HubConfig, only?: string): UpstreamStatus[] {
  const stored = store.listUpstreamCredentials();
  const rows: UpstreamStatus[] = [];
  const pendingFor = new Set(Object.values(store.listUpstreamLogins()).map(login => login.serverName));
  for (const [name, server] of config) {
    if (server.kind !== 'remote' || !server.oauth) continue;
    if (only && name !== only) continue;
    const auth = new UpstreamAuth(name, server, store, store.getExternalUrl() ?? 'http://localhost/');
    // Reading through the manager applies the fingerprint check, so a record
    // left over from a previous configuration shows up as `stale` rather than
    // as a working credential.
    const current = store.getUpstreamCredentials(name, auth.fingerprint);
    const record: UpstreamCredentials | undefined = current ?? stored[name];
    rows.push({
      server: name,
      mode: server.oauth.mode,
      grant: server.oauth.grant,
      scopes: server.oauth.scopes,
      state: describe(current, record),
      clientId: current?.clientId ?? server.oauth.clientId,
      registered: current?.clientId !== undefined,
      hasRefreshToken: typeof (current?.tokens as { refresh_token?: string } | undefined)?.refresh_token === 'string',
      ...(current?.accessTokenValidUntil ? { accessTokenValidUntil: new Date(current.accessTokenValidUntil * 1000).toISOString() } : {}),
      ...(current?.obtainedAt ? { obtainedAt: new Date(current.obtainedAt * 1000).toISOString() } : {}),
      loginPending: pendingFor.has(name)
    });
  }
  if (only && rows.length === 0) throw new UpstreamCommandError(`Unknown server, or it has no "oauth" block: ${only}`);
  return rows;
}

/** `stale` means a record exists but belongs to a configuration that has since
 *  changed — the operator sees why a login they remember doing does not count. */
function describe(current: UpstreamCredentials | undefined, anyRecord: UpstreamCredentials | undefined): UpstreamStatus['state'] {
  if (!current) return anyRecord ? 'stale' : 'login_required';
  if (!current.tokens) return 'login_required';
  if (current.accessTokenValidUntil !== undefined && current.accessTokenValidUntil <= Math.floor(Date.now() / 1000)) {
    return 'expired';
  }
  return 'authorized';
}
