import crypto from 'node:crypto';
import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { HubOAuthProvider, SESSION_TTL_MS } from './provider.js';
import { renderLoginPage } from './login-page.js';
import { allowFormActionTo, contentSecurityPolicy } from './headers.js';
import type { CimdResolver } from './cimd.js';
import { isLoopbackOnly } from './redirect-uri.js';
import { logSafe } from './text.js';
import { privateKeyJwtAuth } from './private-key-jwt.js';
import { earlyRateLimit } from './rate-limit.js';
import { createRegistrationManagementRoutes } from './registration.js';
import type { AuthStore } from './store.js';

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS_TOTAL = 100;

export interface AuthRoutesOptions {
  provider: HubOAuthProvider;
  /** Backs the RFC 7592 registration management endpoints. */
  store: AuthStore;
  externalUrl: string;
  passwordHash?: string; // bcrypt
  password?: string; // plain, fallback for parity with mcp-auth-proxy
  /** Present when Client ID Metadata Documents are accepted. */
  cimd?: CimdResolver;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private total = { count: 0, resetAt: 0 };

  isBlocked(ip: string): boolean {
    if (this.total.resetAt > Date.now() && this.total.count >= LOGIN_MAX_ATTEMPTS_TOTAL) return true;
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) return false;
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  }

  recordFailure(ip: string): void {
    this.sweepExpired(); // entries are otherwise only dropped on a successful login from that exact IP
    const now = Date.now();
    // Behind a reverse proxy req.ip is the proxy for every request, and a
    // spoofable X-Forwarded-For makes the per-IP counter meaningless — this
    // caps the total either way.
    if (this.total.resetAt < now) this.total = { count: 1, resetAt: now + LOGIN_WINDOW_MS };
    else this.total.count++;
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < now) {
      this.attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (entry.resetAt < now) this.attempts.delete(ip);
    }
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
    this.total = { count: 0, resetAt: 0 };
  }
}

export function createAuthRoutes(options: AuthRoutesOptions): Router {
  const { provider, externalUrl } = options;
  if (!options.passwordHash && !options.password) {
    throw new Error('Either PASSWORD_HASH (bcrypt) or PASSWORD must be set');
  }
  const issuerUrl = new URL(externalUrl);
  const router = Router();
  const rateLimiter = new LoginRateLimiter();

  // Keep the password login/consent pages and the OAuth token responses out of
  // any shared or browser cache (RFC 6749 §5.1 requires no-store on token
  // responses; the login form has no business being cached either). The CSP
  // and legacy frame header keep an attacker from clickjacking approval or
  // password entry. This application has no legitimate framing use case.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', contentSecurityPolicy());
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // RFC 7592 registration management. It goes first for two reasons: the SDK's
  // registration router is mounted on the /register prefix and answers 405 to
  // anything that is not a POST, and the registration budget below is also
  // prefix-scoped — routine management would otherwise use up a client's
  // ability to register at all. It brings its own, more generous limit.
  if (provider.clientsStore.registerClient) {
    router.use(createRegistrationManagementRoutes({ store: options.store, externalUrl: issuerUrl.href }));
  }

  // These run before the SDK's JSON/form parsers. The SDK applies its own
  // endpoint limits too, but those otherwise happen only after body parsing.
  router.use('/register', earlyRateLimit(60 * 60_000, 20, 200));
  router.use('/authorize', earlyRateLimit(15 * 60_000, 100, 1_000));
  router.use('/token', earlyRateLimit(15 * 60_000, 50, 500));
  router.use('/login', earlyRateLimit(15 * 60_000, 100, 500));
  router.use('/consent', earlyRateLimit(15 * 60_000, 100, 500));

  // Advertised capabilities. The SDK's document knows nothing about Client ID
  // Metadata Documents, so the two fields clients key their registration
  // choice on are added here: client_id_metadata_document_supported is what
  // makes a spec-compliant client prefer CIMD over dynamic registration, and
  // private_key_jwt is how a CIMD client authenticates at the token endpoint —
  // it can hold no shared secret.
  const asMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl }),
    ...(options.cimd
      ? {
          client_id_metadata_document_supported: true,
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none', 'private_key_jwt'],
          token_endpoint_auth_signing_alg_values_supported: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']
        }
      : {})
  };

  if (options.cimd) {
    // Ahead of mcpAuthRouter so it wins the route, and ahead of the SDK's own
    // body parser — which is harmless, because body-parser leaves an
    // already-read request alone and req.body survives into the SDK handler.
    router.use(
      '/token',
      express.urlencoded({ extended: false }),
      privateKeyJwtAuth({ resolver: options.cimd, externalUrl: issuerUrl.href, tokenEndpoint: asMetadata.token_endpoint })
    );
    // mcpAuthRouter serves the root RFC 8414 document itself, so the enriched
    // one has to be registered before it to take precedence.
    router.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json(asMetadata);
    });
  }

  if (!provider.clientsStore.registerClient) {
    // With dynamic registration off the SDK never mounts /register, and the
    // request would otherwise fall through to the MCP routes and come back as
    // a 401 — telling a client to authenticate at an endpoint that no longer
    // exists. Say what actually happened instead.
    router.all('/register', (_req, res) => {
      res
        .status(404)
        .json({ error: 'not_found', error_description: 'Dynamic client registration is disabled; use a client ID metadata document' });
    });
  }

  // Standard AS endpoints: /.well-known/*, /authorize, /token, /register, /revoke
  router.use(mcpAuthRouter({ provider, issuerUrl, resourceName: 'mcp-hub' }));

  // Path-scoped metadata (RFC 9728 §3.1): clients connected to /<name>/mcp look
  // up /.well-known/oauth-protected-resource/<name>/mcp before falling back to
  // the root document, and RFC 8414 has an equivalent path-insertion form for
  // AS metadata. Serve both for any suffix; one AS covers all resources.
  router.get('/.well-known/oauth-authorization-server/{*splat}', (_req, res) => {
    res.json(asMetadata);
  });
  // OIDC Discovery alias: some clients (ChatGPT among them) probe
  // /.well-known/openid-configuration instead of — or before — the RFC 8414
  // path, and the MCP spec requires clients to support both. The RFC 8414
  // document is a compatible answer for the fields such clients read.
  router.get('/.well-known/openid-configuration', (_req, res) => {
    res.json(asMetadata);
  });
  router.get('/.well-known/openid-configuration/{*splat}', (_req, res) => {
    res.json(asMetadata);
  });
  router.get('/.well-known/oauth-protected-resource/{*splat}', (req, res) => {
    const suffix = req.path.replace('/.well-known/oauth-protected-resource', '');
    res.json({
      resource: issuerUrl.origin + suffix,
      authorization_servers: [externalUrl],
      bearer_methods_supported: ['header'],
      resource_name: 'mcp-hub'
    });
  });

  const checkPassword = (password: string): boolean => {
    if (options.passwordHash) return bcrypt.compareSync(password, options.passwordHash);
    const expected = Buffer.from(options.password!);
    const given = Buffer.from(password);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  };

  router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const { password, request } = req.body as { password?: string; request?: string };
    const pending = typeof request === 'string' ? provider.decodePendingAuthorization(request) : undefined;
    if (!pending) {
      res.status(400).type('html').send('<p>Authorization request expired. Close this window and connect again.</p>');
      return;
    }
    if (rateLimiter.isBlocked(ip)) {
      console.warn(`mcp-hub: login rate limit exceeded from ${logSafe(ip)}`);
      res.status(429).type('html').send('<p>Too many attempts. Try again later.</p>');
      return;
    }
    if (typeof password !== 'string' || !checkPassword(password)) {
      rateLimiter.recordFailure(ip);
      console.warn(`mcp-hub: authentication failure from ${logSafe(ip)}`);
      // The retry form has to reach the same redirect as the first attempt,
      // and say the same things about who is asking.
      const retryClient = await provider.clientsStore.getClient(pending.clientId);
      allowFormActionTo(res, pending.redirectUri);
      res
        .status(401)
        .type('html')
        .send(
          renderLoginPage(
            request!,
            pending.redirectUri,
            {
              clientName: retryClient?.client_name,
              resource: pending.resource,
              clientId: provider.isMetadataDocumentClient(pending.clientId) ? pending.clientId : undefined,
              loopbackOnly: isLoopbackOnly(retryClient?.redirect_uris)
            },
            'Wrong password'
          )
        );
      return;
    }
    rateLimiter.reset(ip);
    console.log(`mcp-hub: successful login from ${logSafe(ip)}`);
    res.cookie(provider.sessionCookieName, provider.createSessionCookie(), {
      httpOnly: true,
      secure: issuerUrl.protocol === 'https:',
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/'
    });
    const client = await provider.clientsStore.getClient(pending.clientId);
    if (!client) {
      res.status(400).type('html').send('<p>Unknown client. Close this window and connect again.</p>');
      return;
    }
    provider.approve(client, pending.redirectUri); // typing the password is the consent
    provider.redirectWithCode(client, pending, res);
  });

  // Reached from the consent page when a signed-in user authorizes a client
  // for the first time. Everything here has to hold even though the request
  // may have been triggered by a page the user did not expect to land on.
  router.post('/consent', express.urlencoded({ extended: false }), async (req, res) => {
    const { request, csrf, action } = req.body as { request?: string; csrf?: string; action?: string };
    const pending = typeof request === 'string' ? provider.decodePendingAuthorization(request) : undefined;
    if (!pending) {
      res.status(400).type('html').send('<p>Authorization request expired. Close this window and connect again.</p>');
      return;
    }
    const session = provider.readSessionCookie(req.headers.cookie);
    if (!session) {
      res.status(401).type('html').send('<p>Session expired. Close this window and connect again.</p>');
      return;
    }
    if (!provider.verifyCsrfToken(session, csrf)) {
      console.warn(`mcp-hub: consent with an invalid CSRF token from ${logSafe(req.ip ?? 'unknown')}`);
      res.status(403).type('html').send('<p>Invalid request. Close this window and connect again.</p>');
      return;
    }
    if (action !== 'approve') {
      console.log(`mcp-hub: authorization denied for client ${pending.clientId}`);
      provider.redirectWithError(pending.redirectUri, pending.state, 'access_denied', res);
      return;
    }
    const client = await provider.clientsStore.getClient(pending.clientId);
    if (!client) {
      res.status(400).type('html').send('<p>Unknown client. Close this window and connect again.</p>');
      return;
    }
    provider.approve(client, pending.redirectUri);
    provider.redirectWithCode(client, pending, res);
  });

  return router;
}
