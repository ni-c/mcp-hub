import crypto from 'node:crypto';
import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { HubOAuthProvider, SESSION_TTL_MS } from './provider.js';
import { renderLoginPage } from './login-page.js';

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS_TOTAL = 100;

function earlyRateLimit(windowMs: number, maxPerIp: number, maxTotal: number) {
  const byIp = new Map<string, { count: number; resetAt: number }>();
  let total = { count: 0, resetAt: 0 };
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const now = Date.now();
    if (total.resetAt <= now) total = { count: 0, resetAt: now + windowMs };
    const ip = req.ip ?? 'unknown';
    let entry = byIp.get(ip);
    if (entry && entry.resetAt <= now) {
      byIp.delete(ip);
      entry = undefined;
    }
    // Reject before inserting anything: a flood of distinct rejected IPs must
    // not grow the map. Accepted requests bound it at maxTotal per window.
    if ((entry?.count ?? 0) >= maxPerIp || total.count >= maxTotal) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((Math.min(entry?.resetAt ?? Infinity, total.resetAt) - now) / 1000))));
      res.status(429).json({ error: 'too_many_requests', error_description: 'Request rate limit exceeded' });
      return;
    }
    if (!entry) {
      if (byIp.size >= maxTotal) {
        for (const [candidateIp, candidate] of byIp) if (candidate.resetAt <= now) byIp.delete(candidateIp);
      }
      entry = { count: 0, resetAt: now + windowMs };
      byIp.set(ip, entry);
    }
    entry.count++;
    total.count++;
    next();
  };
}

export interface AuthRoutesOptions {
  provider: HubOAuthProvider;
  externalUrl: string;
  passwordHash?: string; // bcrypt
  password?: string; // plain, fallback for parity with mcp-auth-proxy
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
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // These run before the SDK's JSON/form parsers. The SDK applies its own
  // endpoint limits too, but those otherwise happen only after body parsing.
  router.use('/register', earlyRateLimit(60 * 60_000, 20, 200));
  router.use('/authorize', earlyRateLimit(15 * 60_000, 100, 1_000));
  router.use('/token', earlyRateLimit(15 * 60_000, 50, 500));
  router.use('/login', earlyRateLimit(15 * 60_000, 100, 500));
  router.use('/consent', earlyRateLimit(15 * 60_000, 100, 500));

  // Standard AS endpoints: /.well-known/*, /authorize, /token, /register, /revoke
  router.use(mcpAuthRouter({ provider, issuerUrl, resourceName: 'mcp-hub' }));

  // Path-scoped metadata (RFC 9728 §3.1): clients connected to /<name>/mcp look
  // up /.well-known/oauth-protected-resource/<name>/mcp before falling back to
  // the root document, and RFC 8414 has an equivalent path-insertion form for
  // AS metadata. Serve both for any suffix; one AS covers all resources.
  const asMetadata = createOAuthMetadata({ provider, issuerUrl });
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
      console.warn(`mcp-hub: login rate limit exceeded from ${ip}`);
      res.status(429).type('html').send('<p>Too many attempts. Try again later.</p>');
      return;
    }
    if (typeof password !== 'string' || !checkPassword(password)) {
      rateLimiter.recordFailure(ip);
      console.warn(`mcp-hub: authentication failure from ${ip}`);
      res.status(401).type('html').send(renderLoginPage(request!, pending.redirectUri, undefined, 'Wrong password', pending.resource));
      return;
    }
    rateLimiter.reset(ip);
    console.log(`mcp-hub: successful login from ${ip}`);
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
      console.warn(`mcp-hub: consent with an invalid CSRF token from ${req.ip ?? 'unknown'}`);
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
