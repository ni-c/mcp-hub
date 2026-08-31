import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type Provider from 'oidc-provider';

import type { AuthStore } from '../store.js';

/**
 * The one scope the hub knows. Authorization is per client, not per scope —
 * what a token may reach is decided by the resource it is bound to — but
 * oidc-provider requires a non-empty granted∩requested set, so the hub needs a
 * name for "everything this client was approved for". See `defaultScope`.
 */
export const HUB_SCOPE = 'mcp';

/**
 * Four deliberate concessions to two real clients. Every one of them is
 * load-bearing: three are pinned by test/client-compat.test.ts because a real
 * connector broke without them, and the fourth was found by running a real
 * authorization flow against oidc-provider.
 *
 *   1. `client_secret_expires_at: 0` for every client. ChatGPT registers once
 *      per connector and never re-registers, so an expiring secret bricks it.
 *      Needs no code: registration.js hardcodes 0 and forbids changing it.
 *
 *   2. A throwaway `client_secret` for PUBLIC clients — below.
 *   3. Refresh tokens without `offline_access` — in provider.ts.
 *   4. Authorization with no `scope` parameter — `defaultScope` below.
 */

/**
 * Quirk 2. ChatGPT refuses its own registration unless the response carries a
 * `client_secret`, even for `token_endpoint_auth_method: 'none'`. Claude is
 * correct and sends none, so the secret must exist in the response and NOT in
 * the stored record — otherwise every well-behaved public client breaks.
 *
 * oidc-provider already gets the storage half right: `Client.needsSecret` is
 * false for 'none', so registration.js deletes the secret before persisting.
 * Only the response needs fixing, and `provider.use()` is the documented place:
 * it installs middleware ahead of the router, so `await next()` returns after
 * ctx.body was set and before Koa serialises it.
 *
 * Not `features.registration.policies` and not `extraClientMetadata`: both run
 * on the properties *before* they are persisted, so both would store the secret
 * and defeat the whole point.
 */
export function installThrowawaySecret(provider: Provider, store?: AuthStore): void {
  provider.use(async (ctx, next) => {
    await next();
    const body = ctx.body as Record<string, unknown> | undefined;
    if (ctx.oidc?.route !== 'registration' || ctx.status !== 201 || !body) return;

    if (body.token_endpoint_auth_method === 'none' && body.client_secret === undefined) {
      body.client_secret = crypto.randomBytes(32).toString('base64url');
      body.client_secret_expires_at = 0;
    }

    // The only moment the registration access token is visible. The hub stores
    // just its hash, which is what lets RFC 7592 management stay on mcp-hub's
    // own, stricter implementation.
    if (store && typeof body.client_id === 'string' && typeof body.registration_access_token === 'string') {
      store.rememberRegistrationToken(body.client_id, body.registration_access_token);
    }
  });
}

/**
 * RFC 8414 lists `revocation_endpoint_auth_methods_supported`, the hub
 * advertised it, and oidc-provider does not emit it at all. A client that reads
 * the document to decide how to authenticate at /revoke would find nothing
 * where there used to be an answer.
 *
 * Same mechanism as the throwaway secret: middleware installed ahead of the
 * router, so `ctx.body` is still a plain object when it returns.
 */
export function installDiscoveryFixups(provider: Provider): void {
  provider.use(async (ctx, next) => {
    await next();
    const body = ctx.body as Record<string, unknown> | undefined;
    if (ctx.oidc?.route === 'discovery' && ctx.status === 200 && body?.revocation_endpoint) {
      body.revocation_endpoint_auth_methods_supported = ['client_secret_post', 'none', 'private_key_jwt'];
    }
  });
}

/**
 * Quirk 4. MCP clients send no `scope` parameter at all.
 *
 * actions/authorization/interactions.js filters the GRANTED scopes by the
 * REQUESTED ones and throws `access_denied` when the intersection is empty —
 * so with no scope requested the flow dead-ends no matter what was granted.
 * The hub issues scopeless, resource-bound tokens today, so defaulting the
 * scope preserves current behaviour; demanding one from the clients would not,
 * because they will never send it.
 *
 * A client that DOES ask for something is left alone.
 */
export const defaultScope: RequestHandler = (req, _res, next) => {
  const url = new URL(req.url, 'http://placeholder.invalid');
  if (!url.searchParams.get('scope')) {
    url.searchParams.set('scope', HUB_SCOPE);
    req.url = `${url.pathname}${url.search}`;
  }
  next();
};

/**
 * Restores the hub's existing tolerance for a client that presents the
 * throwaway secret from quirk 2 back at the token endpoint.
 *
 * The SDK the hub used before gated on the STORED client having a secret
 * (clientAuth.js: `if (client.client_secret)`), and public clients have none,
 * so a presented secret was ignored. oidc-provider gates on the PRESENTED one
 * (client_auth.js: any client_secret selects client_secret_basic/post) and then
 * hard-fails with `401 invalid_client` because the record says 'none'.
 *
 * Whether ChatGPT actually echoes the secret is unknown and unknowable from the
 * outside — which is the reason to be tolerant rather than to find out from a
 * bug report. `ctx.oidc.params` is built inside the router, after every
 * provider.use() middleware, so the raw body before the mount is the only place
 * this can happen.
 */
export function stripPhantomSecret(store: AuthStore, callback: (req: Request, res: Response) => void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Anything that is not a POST still belongs to the provider, which answers
    // 405. Handing it to next() instead would drop it into the hub's catch-all
    // and turn a documented endpoint into a 404.
    if (req.method !== 'POST') {
      callback(req, res);
      return;
    }
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const clientId = params.get('client_id');
        if (params.get('client_secret') && clientId) {
          const client = store.getClient(clientId);
          // A public client never had a secret, so whatever was presented is
          // the throwaway one the hub itself handed out.
          if (client && client.client_secret === undefined) params.delete('client_secret');
        }
        const body = Buffer.from(params.toString());
        const shim = Readable.from([body]) as Readable & Record<string, unknown>;
        Object.assign(shim, {
          headers: { ...req.headers, 'content-length': String(body.length) },
          method: req.method,
          url: req.url,
          socket: req.socket,
          httpVersion: req.httpVersion
        });
        callback(shim as unknown as Request, res);
      } catch (error) {
        next(error);
      }
    })();
  };
}
