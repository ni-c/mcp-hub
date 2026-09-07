import express, { Router } from 'express';
import type Provider from 'oidc-provider';

import type { CimdResolver } from '../cimd.js';
import { renderConsentPage } from '../consent-page.js';
import { allowFormActionTo, authSecurityHeaders } from '../headers.js';
import { renderLoginPage } from '../login-page.js';
import { earlyRateLimit, LoginRateLimiter } from '../rate-limit.js';
import { operatorCredential } from '../password.js';
import { isLoopbackOnly } from '../redirect-uri.js';
import { createSessionCookie, csrfToken, readSessionCookie, SESSION_TTL_MS, sessionCookieName, verifyCsrfToken } from '../session.js';
import type { AuthStore } from '../store.js';
import { logSafe } from '../text.js';
import { HUB_ACCOUNT_ID } from './provider.js';

export interface OidcInteractionOptions {
  provider: Provider;
  store: AuthStore;
  externalUrl: string;
  password?: string;
  passwordHash?: string;
  cimd?: CimdResolver;
}

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>;

/** Express 5 forwards a rejected handler promise on its own; this makes that explicit and typed. */
const asyncHandler =
  (handler: AsyncHandler): express.RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };

function expired(res: express.Response, status: number, message: string): void {
  res.status(status).type('html').send(`<p>${message}</p>`);
}

/**
 * The hub's own login and consent pages, driven by oidc-provider's interaction
 * loop instead of by HubOAuthProvider's hand-rolled one.
 *
 * The pages themselves are unchanged. They post to a RELATIVE `login` and
 * `consent`, and that resolves to `/interaction/<uid>/login` because the page is
 * served from a path ending in a slash — which it has to be anyway, since
 * oidc-provider scopes the interaction cookie to exactly that path. The
 * interaction id still travels in the hidden `request` field too, and is checked
 * so a form cannot be replayed against a different interaction.
 *
 * Two behaviours from the old flow are load-bearing and preserved here:
 *
 *   - **Typing the password is the consent.** A first-time client is approved
 *     by the login itself, so the consent page is only ever shown to someone
 *     who is already signed in and is being asked about a NEW client.
 *   - **One session cookie.** `mcp_hub_session` is set alongside
 *     oidc-provider's own, because `hasValidSession()` is read outside the auth
 *     layer by the upstream OAuth callback. Without it the operator would have
 *     to log in twice for two different things.
 */
export function createOidcInteractionRoutes(options: OidcInteractionOptions): Router {
  const { provider, store } = options;
  const router = Router();
  const rateLimiter = new LoginRateLimiter();

  // The pages this router serves are the ones with a password field on them, so
  // they need the anti-clickjacking and no-store headers at least as much as
  // the token endpoint does. `allowFormActionTo` narrows the CSP afterwards for
  // the single page that has a redirect target to allow.
  router.use(authSecurityHeaders);
  const secure = new URL(options.externalUrl).protocol === 'https:';

  // Missing or unusable means nobody signs in — never that anybody does. The
  // empty-buffer comparison this replaced let an empty form field through when
  // no password was configured, which approved the client and minted tokens.
  const credential = operatorCredential(options);
  const disabledNotice = 'Sign-in is disabled: this hub has no usable operator password configured.';

  /** What the page may say about who is asking, and what it must not claim. */
  const identityOf = async (clientId: string, resource?: string) => {
    const client = await provider.Client.find(clientId);
    const metadata = client?.metadata() as Record<string, unknown> | undefined;
    return {
      clientName: typeof metadata?.client_name === 'string' ? metadata.client_name : undefined,
      resource,
      // A metadata-document client is identified by a URL nobody can forge, so
      // the page can show where the self-declared name came from.
      clientId: options.cimd && clientId.startsWith('https://') ? clientId : undefined,
      loopbackOnly: isLoopbackOnly(metadata?.redirect_uris as string[] | undefined)
    };
  };

  // The two POSTs below carry a limiter and this GET did not, which is the
  // asymmetry CodeQL noticed and it was right. The page is unauthenticated by
  // construction — the uid is all a caller has — and rendering it costs a
  // provider store lookup, so a flood is cheap to send and not free to serve.
  // The same window as its siblings; a person opening a login page a hundred
  // times in fifteen minutes has a different problem.
  router.get(
    '/interaction/:uid',
    earlyRateLimit(15 * 60_000, 100, 500),
    asyncHandler(async (req, res) => {
      try {
        const details = await provider.interactionDetails(req, res);
        const params = details.params as { client_id?: string; redirect_uri?: string; resource?: string };
        const redirectUri = String(params.redirect_uri ?? '');
        const identity = await identityOf(String(params.client_id), params.resource);
        allowFormActionTo(res, redirectUri);

        if (details.prompt.name === 'login') {
          res
            .status(credential.enabled ? 200 : 503)
            .type('html')
            .send(renderLoginPage(details.uid, redirectUri, identity, credential.enabled ? undefined : disabledNotice));
          return;
        }
        const session = readSessionCookie(req.headers.cookie, store.cookieSecret, secure);
        if (!session) {
          expired(res, 401, 'Session expired. Close this window and connect again.');
          return;
        }
        res
          .status(200)
          .type('html')
          .send(renderConsentPage(details.uid, csrfToken(session, store.cookieSecret), redirectUri, identity));
      } catch {
        // interactionDetails throws for an unknown or expired uid, which is not
        // an error worth a stack trace: the window was left open too long.
        expired(res, 400, 'Authorization request expired. Close this window and connect again.');
      }
    })
  );

  router.post(
    '/interaction/:uid/login',
    earlyRateLimit(15 * 60_000, 100, 500),
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const ip = req.ip ?? 'unknown';
      const { password, request } = req.body as { password?: string; request?: string };
      let details;
      try {
        details = await provider.interactionDetails(req, res);
      } catch {
        expired(res, 400, 'Authorization request expired. Close this window and connect again.');
        return;
      }
      if (typeof request !== 'string' || request !== details.uid) {
        expired(res, 400, 'Authorization request expired. Close this window and connect again.');
        return;
      }
      if (rateLimiter.isBlocked(ip)) {
        console.warn(`mcp-hub: login rate limit exceeded from ${logSafe(ip)}`);
        expired(res, 429, 'Too many attempts. Try again later.');
        return;
      }

      const params = details.params as { client_id?: string; redirect_uri?: string; resource?: string };
      const redirectUri = String(params.redirect_uri ?? '');
      if (!credential.enabled) {
        // Not a failed guess: there is nothing to guess. Counting it would let
        // a misconfigured hub fill the fail2ban log with its own visitors.
        const identity = await identityOf(String(params.client_id), params.resource);
        allowFormActionTo(res, redirectUri);
        res.status(503).type('html').send(renderLoginPage(details.uid, redirectUri, identity, disabledNotice));
        return;
      }
      if (typeof password !== 'string' || !credential.check(password)) {
        rateLimiter.recordFailure(ip);
        console.warn(`mcp-hub: authentication failure from ${logSafe(ip)}`);
        const identity = await identityOf(String(params.client_id), params.resource);
        allowFormActionTo(res, redirectUri);
        res.status(401).type('html').send(renderLoginPage(details.uid, redirectUri, identity, 'Wrong password'));
        return;
      }

      rateLimiter.reset(ip);
      console.log(`mcp-hub: successful login from ${logSafe(ip)}`);
      // Typing the password is the consent for the client that triggered it.
      const clientId = String(params.client_id);
      const client = await provider.Client.find(clientId);
      const clientName = (client?.metadata() as Record<string, unknown> | undefined)?.client_name;
      store.saveApproval(clientId, redirectUri, typeof clientName === 'string' ? clientName : undefined);
      console.log(`mcp-hub: approved OAuth client ${logSafe(clientId)} for ${logSafe(redirectUri)}`);

      // `__Host-` behind HTTPS: the browser then refuses the cookie from any
      // other origin, path or domain, so nobody can fix a session into this
      // browser from a sibling host. No `domain`, and `path: '/'`, are what the
      // prefix requires.
      res.cookie(sessionCookieName(secure), createSessionCookie(store.cookieSecret), {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS,
        path: '/'
      });
      await provider.interactionFinished(req, res, { login: { accountId: HUB_ACCOUNT_ID } }, { mergeWithLastSubmission: false });
    })
  );

  router.post(
    '/interaction/:uid/consent',
    earlyRateLimit(15 * 60_000, 100, 500),
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const { request, csrf, action } = req.body as { request?: string; csrf?: string; action?: string };
      let details;
      try {
        details = await provider.interactionDetails(req, res);
      } catch {
        expired(res, 400, 'Authorization request expired. Close this window and connect again.');
        return;
      }
      if (typeof request !== 'string' || request !== details.uid) {
        expired(res, 400, 'Authorization request expired. Close this window and connect again.');
        return;
      }
      const session = readSessionCookie(req.headers.cookie, store.cookieSecret, secure);
      if (!session) {
        expired(res, 401, 'Session expired. Close this window and connect again.');
        return;
      }
      if (!verifyCsrfToken(session, csrf, store.cookieSecret)) {
        console.warn(`mcp-hub: consent with an invalid CSRF token from ${logSafe(req.ip ?? 'unknown')}`);
        expired(res, 403, 'This form is no longer valid. Close this window and connect again.');
        return;
      }

      if (action !== 'approve') {
        await provider.interactionFinished(req, res, { error: 'access_denied' }, { mergeWithLastSubmission: false });
        return;
      }

      const params = details.params as { client_id?: string; redirect_uri?: string };
      const clientId = String(params.client_id);
      const client = await provider.Client.find(clientId);
      const clientName = (client?.metadata() as Record<string, unknown> | undefined)?.client_name;
      store.saveApproval(clientId, String(params.redirect_uri ?? ''), typeof clientName === 'string' ? clientName : undefined);
      console.log(`mcp-hub: approved OAuth client ${logSafe(clientId)} for ${logSafe(String(params.redirect_uri ?? ''))}`);
      // The grant itself is minted by loadExistingGrant on the resumed request,
      // which is the same code path an already-approved client takes.
      await provider.interactionFinished(req, res, { consent: {} }, { mergeWithLastSubmission: true });
    })
  );

  return router;
}
