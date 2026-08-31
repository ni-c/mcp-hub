import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { jwtVerify } from 'jose';

import { API_TOKEN_SUBJECT } from '../api-tokens.js';
import type { AuthStore } from '../store.js';

export interface OidcVerifierOptions {
  /** `URL.href` form, byte-identical to the `iss` on every minted token. */
  externalUrl: string;
  /** Canonicalises an audience, or undefined when the hub would not serve it. */
  resolveResource: (resource: URL) => URL | undefined;
  /** Mirrors RESOURCE_BOUND_TOKENS: false lets an unbound token through. */
  requireResource: boolean;
}

/**
 * Verifies the two token shapes the hub hands out, which are deliberately not
 * the same shape.
 *
 * OAuth access tokens are **opaque**. That is what makes revocation immediate:
 * the value is the record's id, so the lookup below is the enforcement point,
 * and `AuthStore.oidcFind` refuses anything past its expiry or minted before a
 * `revokedBefore` cutoff. A JWT could not be revoked at all — oidc-provider
 * never persists one.
 *
 * Admin-minted API tokens stay **JWTs**, signed with the hub's own key. They
 * are not OAuth artifacts: `mcp-hub-admin tokens create` issues them for
 * clients that cannot do OAuth at all, and only their record (jti) is stored,
 * which is what `tokens revoke` deletes.
 *
 * Order matters. Opaque is tried first because it is the common case and needs
 * no cryptography; a value that is not a stored token then gets exactly one
 * signature check. Neither branch may report why it failed — an attacker must
 * not be able to tell "unknown" from "revoked" from "wrong audience".
 */
export class OidcTokenVerifier {
  constructor(
    private readonly store: AuthStore,
    private readonly options: OidcVerifierOptions
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const opaque = this.store.oidcFind('AccessToken', token);
    if (opaque) return this.fromOpaque(token, opaque);
    return this.fromApiToken(token);
  }

  private fromOpaque(token: string, payload: Record<string, unknown>): AuthInfo {
    const clientId = payload.clientId;
    if (typeof clientId !== 'string') throw new InvalidTokenError('Invalid access token claims');

    // An audience equal to the issuer means "not bound to one resource" — the
    // pre-0.5 shape, kept so a deployment that never turned binding on is not
    // logged out by an upgrade. It passes only while binding is not enforced;
    // the per-route check is what narrows it.
    const audience = typeof payload.aud === 'string' ? payload.aud : undefined;
    let resource: URL | undefined;
    if (audience !== undefined && audience !== this.options.externalUrl) {
      resource = this.resolve(audience);
      if (!resource) throw new InvalidTokenError('Invalid token audience');
    } else if (this.options.requireResource) {
      throw new InvalidTokenError('Invalid token audience');
    }

    const scope = typeof payload.scope === 'string' ? payload.scope : '';
    return {
      token,
      clientId,
      scopes: scope ? scope.split(' ') : [],
      ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
      ...(resource ? { resource } : {})
    };
  }

  private async fromApiToken(token: string): Promise<AuthInfo> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.store.publicKey, {
        issuer: this.options.externalUrl,
        algorithms: ['EdDSA']
      }));
    } catch {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    // Only API tokens are JWTs now. An OAuth token in this shape is one the
    // previous authorization server minted; refusing it is what makes clients
    // authorize once against the new one instead of silently keeping a
    // credential nothing can revoke.
    if (payload.sub !== API_TOKEN_SUBJECT) throw new InvalidTokenError('Invalid access token claims');
    if (typeof payload.jti !== 'string' || !this.store.getApiToken(payload.jti)) {
      throw new InvalidTokenError('Access token has been revoked');
    }

    const audience = typeof payload.aud === 'string' ? payload.aud : undefined;
    const resource = audience ? this.resolve(audience) : undefined;
    if (!resource) throw new InvalidTokenError('Invalid token audience');
    return {
      token,
      clientId: `token:${payload.jti}`,
      scopes: [],
      ...(payload.exp !== undefined ? { expiresAt: payload.exp } : {}),
      resource
    };
  }

  private resolve(audience: string): URL | undefined {
    let parsed: URL;
    try {
      parsed = new URL(audience);
    } catch {
      return undefined;
    }
    return this.options.resolveResource(parsed);
  }
}
