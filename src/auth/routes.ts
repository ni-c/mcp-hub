import crypto from 'node:crypto';
import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { HubOAuthProvider, SESSION_COOKIE, SESSION_TTL_MS } from './provider.js';
import { renderLoginPage } from './login-page.js';

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

export interface AuthRoutesOptions {
  provider: HubOAuthProvider;
  externalUrl: string;
  passwordHash?: string; // bcrypt
  password?: string; // plain, fallback for parity with mcp-auth-proxy
}

class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  isBlocked(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) return false;
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  }

  recordFailure(ip: string): void {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) {
      this.attempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
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
      res.status(401).type('html').send(renderLoginPage(request!, undefined, 'Wrong password'));
      return;
    }
    rateLimiter.reset(ip);
    console.log(`mcp-hub: successful login from ${ip}`);
    res.cookie(SESSION_COOKIE, provider.createSessionCookie(), {
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
    provider.redirectWithCode(client, pending, res);
  });

  return router;
}
