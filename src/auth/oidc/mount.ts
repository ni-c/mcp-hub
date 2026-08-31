import type { Express, Request, RequestHandler, Response } from 'express';
import type Provider from 'oidc-provider';

import type { AuthStore } from '../store.js';
import { defaultScope, stripPhantomSecret } from './quirks.js';

/**
 * Every path the provider answers on, given the `routes` reconfiguration in
 * provider.ts.
 *
 * Two of these are not endpoints and are easy to miss:
 *
 *   - `/authorize/:uid` is the RESUME route (initialize_app.js registers it at
 *     `${routes.authorization}/:uid`). Without it the redirect back from the
 *     login page lands in the hub's 404 handler and the authorization flow
 *     dead-ends silently, with a plausible-looking error.
 *   - `/register/:id` is RFC 7592 registration management.
 *
 * Both `.well-known` paths are served by the provider with an identical body,
 * which is exactly the alias the hub used to build by hand for ChatGPT.
 */
export const OIDC_PATHS = [
  '/authorize',
  '/authorize/:uid',
  '/token',
  '/revoke',
  '/register',
  '/register/:id',
  '/jwks',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration'
] as const;

/**
 * Makes EXTERNAL_URL authoritative for every URL the provider publishes.
 *
 * oidc-provider builds endpoint URLs from the REQUEST (`urlFor` resolves against
 * `ctx.href`), not from the issuer. Two consequences the hub cannot accept:
 *
 *   - behind a reverse proxy the document would advertise the internal host, and
 *   - a request carrying `Host: evil.example` would be answered with a discovery
 *     document pointing at evil.example.
 *
 * The hub already treats EXTERNAL_URL as the single source of truth and compares
 * it byte for byte, so overwriting the request's idea of its own origin is the
 * faithful translation rather than a workaround.
 *
 * It also closes the `provider.proxy` gap. That flag is a boolean — it trusts
 * any `X-Forwarded-*` — whereas Express was configured with a CIDR list. Because
 * all three headers are overwritten here, the client cannot influence them, and
 * `X-Forwarded-For` is replaced with the address Express already resolved
 * against TRUSTED_PROXIES.
 */
export function forceExternalOrigin(externalUrl: string): RequestHandler {
  const url = new URL(externalUrl);
  const proto = url.protocol.replace(':', '');
  return (req, _res, next) => {
    req.headers.host = url.host;
    req.headers['x-forwarded-host'] = url.host;
    req.headers['x-forwarded-proto'] = proto;
    if (req.ip) req.headers['x-forwarded-for'] = req.ip;
    else delete req.headers['x-forwarded-for'];
    next();
  };
}

export interface MountOptions {
  /** The origin every published URL must carry, regardless of the request. */
  externalUrl: string;
  /** Runs on every provider path. The hub's own no-store/CSP/frame headers and
   *  per-path rate limits live in the Express router, which the mounted Koa app
   *  never enters — so they have to be put in front of it explicitly. */
  before?: Partial<Record<(typeof OIDC_PATHS)[number], RequestHandler[]>>;
  common?: RequestHandler[];
}

/**
 * Mounts the authorization server into the hub's Express app.
 *
 * `app.all(path, ...)` and NOT `app.use(path, ...)`: `use` strips the prefix
 * from `req.url`, while oidc-provider derives its own mount path from the
 * issuer (provider.js `#mountPath = new URL(issuer).pathname`). The hub's
 * issuer is the origin root, so stripping would leave the router looking at
 * paths the published URLs do not match.
 *
 * The mounted app is also a dead end — Koa's `handleRequest` always responds,
 * so anything that reaches it never returns to Express. Mounting per path
 * rather than at the root is what keeps `/livez`, `/health` and every MCP route
 * reachable.
 */
export function mountOidcProvider(app: Express, provider: Provider, store: AuthStore, options: MountOptions): void {
  const callback = provider.callback() as unknown as (req: Request, res: Response) => void;
  // Safe only in combination with forceExternalOrigin, which overwrites every
  // forwarded header the client could otherwise set.
  provider.proxy = true;

  /**
   * Errors do not cross the boundary. A throw inside the Koa app is caught by
   * `ctx.onerror` and never reaches the hub's four-argument Express error
   * handler, so without this an authorization-server fault would be invisible
   * in the hub's logs.
   */
  provider.on('server_error', (_ctx, error: Error) => {
    console.error(`mcp-hub: authorization server failed: ${error.message}`);
  });

  /**
   * RFC 8414 also defines a path-insertion form, and clients probing a specific
   * resource look up `/.well-known/oauth-authorization-server/<name>/mcp` before
   * falling back to the root document. oidc-provider registers only the exact
   * paths, so without this the suffix form 404s — which the hub answered before.
   * One authorization server covers every resource, so the answer is the same
   * document.
   */
  for (const base of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    app.get(`${base}/{*splat}`, ...(options.common ?? []), forceExternalOrigin(options.externalUrl), (req, res) => {
      req.url = base;
      callback(req, res);
    });
  }

  for (const path of OIDC_PATHS) {
    const handlers: RequestHandler[] = [
      ...(options.common ?? []),
      ...(options.before?.[path] ?? []),
      forceExternalOrigin(options.externalUrl)
    ];
    if (path === '/authorize') handlers.push(defaultScope);
    // Reads the body, so it has to BE the terminal handler rather than sit in
    // front of one: the request stream can only be consumed once.
    if (path === '/token') handlers.push(stripPhantomSecret(store, callback));
    else handlers.push((req, res) => callback(req, res));
    app.all(path, ...handlers);
  }
}
