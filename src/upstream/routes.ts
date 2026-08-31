import { Router } from 'express';
import type { Response } from 'express';
import type { AuthStore } from '../auth/store.js';
import { readSignedPayload } from '../auth/signed-token.js';
import { renderPage, escapeHtml } from '../auth/page.js';
import { logSafe } from '../auth/text.js';
import type { ConfigWatcher } from '../config.js';
import type { Supervisor, UpstreamAuthRegistry } from '../supervisor.js';
import { readSessionCookie } from '../auth/session.js';
import {
  UPSTREAM_CALLBACK_PATH,
  UPSTREAM_CLIENT_METADATA_PREFIX,
  UpstreamAuthProvider,
  clientDocumentId,
  clientMetadataUrl,
  hubClientMetadata
} from './provider.js';

/**
 * The two public routes the outbound OAuth flow needs.
 *
 * The callback is where an upstream sends the operator's browser back after
 * they signed in. It has to be publicly reachable — that is the whole point —
 * so it is guarded twice over: the `state` is HMAC-signed and single-use, and
 * the browser must additionally carry a valid hub session. Whoever finishes the
 * flow is therefore the operator, not merely someone who saw the redirect.
 *
 * The client metadata document is the hub describing itself to an upstream that
 * supports CIMD. There is one per upstream — two servers may want different
 * scopes, and a shared document would give the second one the first's — and it
 * is answered only while that server actually uses the mode.
 */

export interface UpstreamState {
  /** Server the login belongs to; the query string never decides this. */
  n: string;
  exp: number; // epoch milliseconds
}

export interface UpstreamRoutesOptions {
  store: AuthStore;
  registry: UpstreamAuthRegistry;
  supervisor: Supervisor;
  watcher: ConfigWatcher;
  externalUrl: string;
}

const page = (res: Response, status: number, title: string, body: string): void => {
  res.status(status).type('html').send(renderPage(title, `<form><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></form>`));
};

export function createUpstreamRoutes(options: UpstreamRoutesOptions): Router {
  const { store, registry, supervisor, watcher, externalUrl } = options;
  const router = Router();

  /**
   * One document per upstream, addressed by a derived identifier.
   *
   * Registered unconditionally but answered conditionally: the config is
   * hot-reloadable, so a server can become `cimd` long after boot, and an
   * Express route cannot be added later.
   */
  router.get(`/${UPSTREAM_CLIENT_METADATA_PREFIX}/:id.json`, (req, res) => {
    void (async () => {
      const wanted = String(req.params.id);
      for (const [name, server] of watcher.current) {
        if (server.kind !== 'remote' || server.oauth?.mode !== 'cimd') continue;
        if (clientDocumentId(name, store.cookieSecret) !== wanted) continue;
        const identity = { serverName: name, serverUrl: server.url, oauth: server.oauth, externalUrl };
        const provider = new UpstreamAuthProvider(identity, store);
        // The document must name itself byte-for-byte or the upstream refuses it.
        res.json({
          client_id: clientMetadataUrl(externalUrl, name, store.cookieSecret),
          ...hubClientMetadata(identity, server.oauth.clientAuth === 'private_key_jwt' ? await provider.publicJwk() : undefined)
        });
        return;
      }
      res.status(404).json({ error: 'not_found', error_description: 'No upstream publishes a document here' });
    })();
  });

  router.get(`/${UPSTREAM_CALLBACK_PATH}`, (req, res) => {
    void handleCallback(req.query, req.headers.cookie, res);
  });

  async function handleCallback(query: Record<string, unknown>, cookie: string | undefined, res: Response): Promise<void> {
    const state = typeof query.state === 'string' ? query.state : '';
    const decoded = readSignedPayload<UpstreamState>(state, store.cookieSecret);
    if (!decoded || decoded.exp < Date.now()) {
      console.warn(`mcp-hub: upstream callback with an invalid or expired state`);
      page(res, 400, 'Login expired', 'This authorization is no longer valid. Start it again with mcp-hub-admin upstream login.');
      return;
    }
    // Proving the browser belongs to the operator, not just to whoever ended up
    // holding the redirect. The session cookie rides along because the upstream
    // sends a top-level navigation and the cookie is SameSite=Lax.
    if (readSessionCookie(cookie, store.cookieSecret) === undefined) {
      page(res, 401, 'Not signed in', 'Sign in to this hub in the same browser, then run the login again.');
      return;
    }
    // Single use, and taken before the exchange so a refreshed browser tab
    // cannot redeem the same code twice.
    const login = store.takeUpstreamLogin(state);
    if (!login || login.serverName !== decoded.n) {
      page(res, 400, 'Login expired', 'This authorization was already used or has expired. Start it again.');
      return;
    }
    if (typeof query.error === 'string') {
      console.warn(`mcp-hub: upstream login for ${logSafe(login.serverName)} was declined: ${logSafe(query.error)}`);
      page(res, 400, 'Authorization declined', `The upstream reported "${query.error}". Nothing was changed.`);
      return;
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code) {
      page(res, 400, 'No authorization code', 'The upstream did not send a code. Start the login again.');
      return;
    }
    const auth = registry.get(login.serverName);
    if (!auth) {
      page(res, 400, 'Unknown server', `"${login.serverName}" no longer has an OAuth configuration.`);
      return;
    }
    try {
      await auth.finishLogin(login, code);
    } catch (error) {
      // Never the response body — an OAuth error can carry a token or an
      // assertion. The reason goes to the log, the page says only that it failed.
      console.error(`mcp-hub: upstream login for ${logSafe(login.serverName)} failed: ${logSafe((error as Error).message)}`);
      page(res, 400, 'Login failed', 'The upstream refused the exchange. The hub log has the reason.');
      return;
    }
    console.log(`mcp-hub: upstream login for ${logSafe(login.serverName)} succeeded`);
    // Bring the server back without waiting for it.
    supervisor.get(login.serverName)?.reauthorize();
    page(res, 200, 'Upstream authorized', `${login.serverName} is authorized. You can close this window.`);
  }

  return router;
}
