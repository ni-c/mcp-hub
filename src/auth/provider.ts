import crypto from 'node:crypto';
import type { Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthStore } from './store.js';
import { renderLoginPage } from './login-page.js';
import { renderConsentPage } from './consent-page.js';
import { allowFormActionTo } from './headers.js';

const ACCESS_TOKEN_TTL_S = 15 * 60;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 60_000;
export const SESSION_COOKIE = 'mcp_hub_session';

/**
 * The `__Host-` prefix pins the cookie to this exact origin, so no neighbouring
 * subdomain can plant one. It requires Secure, which rules it out over plain
 * http (local development and the test suite).
 */
export function sessionCookieName(externalUrl: string): string {
  return new URL(externalUrl).protocol === 'https:' ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  exp: number;
  resource?: string;
}

export interface HubOAuthProviderOptions {
  requireResource?: boolean;
  resolveResource?: (resource: URL) => URL | undefined;
  /** Bind tokens here when a client sends no resource parameter at all. */
  defaultResource?: URL;
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** Distinguishes admin-minted API tokens from interactive OAuth tokens. */
export const API_TOKEN_SUBJECT = 'mcp-hub-token';

/**
 * Mint a long-lived, resource-bound API token for clients that cannot do
 * OAuth (OpenAI Responses API, xAI API, Gemini API, plain-header clients).
 * The JWT is returned exactly once; only its record (jti) is persisted, which
 * is what `tokens list` shows and `tokens revoke` deletes.
 */
export async function mintApiToken(
  store: AuthStore,
  externalUrl: string,
  resource: URL,
  days: number,
  label: string
): Promise<{ id: string; token: string; expiresAt: number }> {
  const id = crypto.randomBytes(8).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + days * 86_400;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(new URL(externalUrl).href)
    .setAudience(resource.href)
    .setSubject(API_TOKEN_SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setJti(id)
    .sign(store.privateKey);
  store.saveApiToken(id, { label, resource: resource.href, createdAt: now, expiresAt });
  return { id, token, expiresAt };
}

export class HubOAuthProvider implements OAuthServerProvider {
  /** Short-lived authorization codes; in-memory on purpose (10 min lifetime). */
  private readonly codes = new Map<string, PendingCode>();

  readonly sessionCookieName: string;

  constructor(
    private readonly store: AuthStore,
    private readonly externalUrl: string,
    private readonly options: HubOAuthProviderOptions = {}
  ) {
    this.sessionCookieName = sessionCookieName(externalUrl);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
    return {
      getClient: clientId => store.getClient(clientId),
      registerClient: client => {
        const isPublic = client.token_endpoint_auth_method === 'none';
        const stored: OAuthClientInformationFull = {
          ...client,
          client_id: crypto.randomBytes(16).toString('base64url'),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          // Secrets never expire: ChatGPT registers once per connector and
          // never re-registers, so an expiring secret bricks the connector
          // when it runs out (the SDK default is 30 days).
          client_secret_expires_at: 0
        };
        // A stored secret makes the SDK demand it on every token request, so a
        // public client must be persisted without one — but ChatGPT expects a
        // client_secret in the registration response even for "none" and
        // refuses its own registration otherwise. Hand it one in the response
        // only; token requests from public clients ignore it.
        if (isPublic) delete stored.client_secret;
        store.saveClient(stored);
        console.log(`mcp-hub: registered OAuth client ${stored.client_id} (${stored.client_name ?? 'unnamed'})`);
        return isPublic ? { ...stored, client_secret: crypto.randomBytes(32).toString('hex'), client_secret_expires_at: 0 } : stored;
      }
    };
  }

  // --- Authorization endpoint ---------------------------------------------

  /**
   * A live session alone must not be enough to hand out a code: the cookie
   * rides along on cross-site top-level navigations, so any page could walk a
   * logged-in user through /authorize with a client it registered itself and
   * collect the code. Only clients the user confirmed once are silent; for
   * those the code can only ever land on their own registered redirect_uri.
   *
   * The SDK re-sends on `res` if this method throws, so nothing may throw
   * after the response has gone out.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.resolveResource(params.resource);
    const session = this.readSessionCookie(res.req.headers.cookie);
    if (session && this.isApproved(client, params.redirectUri)) {
      this.redirectWithCode(client, { ...params, resource }, res);
      return;
    }
    const request = this.signPending(client, { ...params, resource });
    const page = session
      ? renderConsentPage(request, this.csrfToken(session), params.redirectUri, client.client_name, resource?.href)
      : renderLoginPage(request, params.redirectUri, client.client_name, undefined, resource?.href);
    // Submitting either form ends in a redirect to this client's redirect_uri,
    // which the SDK has already matched against its registration.
    allowFormActionTo(res, params.redirectUri);
    res.status(200).type('html').send(page);
  }

  /** Everything the login/consent form has to carry across, signed so it
   *  cannot be tampered with while it sits in the browser. */
  private signPending(client: OAuthClientInformationFull, params: AuthorizationParams): string {
    const resource = this.resolveResource(params.resource);
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      exp: Date.now() + CODE_TTL_MS,
      resource: resource?.href
    };
    const payload = Buffer.from(JSON.stringify(pending)).toString('base64url');
    return `${payload}.${sign(payload, this.store.cookieSecret)}`;
  }

  isApproved(client: OAuthClientInformationFull, redirectUri: string): boolean {
    const approval = this.store.getApproval(client.client_id);
    // Same matching the SDK applies at registration, so a loopback client that
    // picks a fresh port every run stays approved.
    return approval?.redirectUris.some(uri => redirectUriMatches(redirectUri, uri)) ?? false;
  }

  approve(client: OAuthClientInformationFull, redirectUri: string): void {
    this.store.saveApproval(client.client_id, redirectUri, client.client_name);
    console.log(`mcp-hub: approved OAuth client ${client.client_id} (${client.client_name ?? 'unnamed'}) for ${redirectUri}`);
  }

  decodePendingAuthorization(token: string): PendingAuthorization | undefined {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return undefined;
    const expected = sign(payload, this.store.cookieSecret);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    const pending = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PendingAuthorization;
    if (pending.exp < Date.now()) return undefined;
    return pending;
  }

  redirectWithCode(
    client: OAuthClientInformationFull,
    params: { redirectUri: string; codeChallenge: string; state?: string; scopes?: string[]; resource?: string | URL },
    res: Response
  ): void {
    const resource = typeof params.resource === 'string' ? params.resource : this.resolveResource(params.resource)?.href;
    const code = crypto.randomBytes(32).toString('base64url');
    this.sweepExpiredCodes();
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + CODE_TTL_MS,
      resource
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    res.redirect(target.toString());
  }

  /** RFC 6749 §4.1.2.1 — tell the client it was turned down instead of
   *  leaving it to time out. */
  redirectWithError(redirectUri: string, state: string | undefined, error: string, res: Response): void {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    if (state !== undefined) target.searchParams.set('state', state);
    res.redirect(target.toString());
  }

  /** Codes are otherwise only dropped on redemption, so unredeemed ones from
   *  anyone who can register a client would accumulate for the process' life. */
  private sweepExpiredCodes(): void {
    const now = Date.now();
    for (const [code, pending] of this.codes) {
      if (pending.expiresAt < now) this.codes.delete(code);
    }
  }

  // --- Session cookie ------------------------------------------------------

  createSessionCookie(): string {
    const expires = String(Date.now() + SESSION_TTL_MS);
    return `${expires}.${sign(expires, this.store.cookieSecret)}`;
  }

  /** The verified cookie value, which doubles as the handle the consent
   *  form's CSRF token is bound to. */
  readSessionCookie(cookieHeader: string | undefined): string | undefined {
    const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${this.sessionCookieName}=([^;]+)`));
    if (!match) return undefined;
    const value = decodeURIComponent(match[1]);
    const [expires, signature] = value.split('.');
    if (!expires || !signature) return undefined;
    const expected = sign(expires, this.store.cookieSecret);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    return Number(expires) > Date.now() ? value : undefined;
  }

  hasValidSession(cookieHeader: string | undefined): boolean {
    return this.readSessionCookie(cookieHeader) !== undefined;
  }

  csrfToken(sessionValue: string): string {
    return sign(`csrf:${sessionValue}`, this.store.cookieSecret);
  }

  verifyCsrfToken(sessionValue: string, token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const expected = this.csrfToken(sessionValue);
    return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }

  // --- Token endpoint ------------------------------------------------------

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code');
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.expiresAt < Date.now() || pending.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== pending.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    const requestedResource = resource ? this.resolveResource(resource) : undefined;
    if (resource && requestedResource?.href !== pending.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    this.codes.delete(authorizationCode); // single use
    return this.issueTokens(client.client_id, pending.scopes, undefined, pending.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.store.getRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      // Seeing a token that was already rotated away means the chain leaked:
      // the legitimate holder and someone else both have one. Drop them all.
      const consumed = this.store.wasConsumed(refreshToken);
      if (consumed) {
        const revoked = this.store.revokeFamily(consumed.familyId);
        console.warn(`mcp-hub: refresh token replay from client ${client.client_id}, revoked ${revoked} token(s)`);
      }
      throw new InvalidGrantError('Invalid refresh token');
    }
    if (scopes && !scopes.every(scope => record.scopes.includes(scope))) {
      throw new InvalidGrantError('Requested scopes exceed the original grant');
    }
    const requestedResource = resource ? this.resolveResource(resource) : undefined;
    if (resource && !requestedResource) throw new InvalidTargetError('Unknown or invalid resource');
    if (record.resource && requestedResource && record.resource !== requestedResource.href) {
      throw new InvalidGrantError('resource does not match the original grant');
    }
    const tokenResource = requestedResource?.href ?? record.resource;
    if (this.options.requireResource && !tokenResource) throw new InvalidTargetError('A resource indicator is required');
    // Tokens issued before families existed adopt one on their first rotation.
    const familyId = record.familyId ?? crypto.randomBytes(16).toString('base64url');
    this.store.consumeRefreshToken(refreshToken, familyId, record.expiresAt);
    return this.issueTokens(client.client_id, scopes ?? record.scopes, familyId, tokenResource);
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    familyId: string = crypto.randomBytes(16).toString('base64url'),
    resource?: string
  ): Promise<OAuthTokens> {
    const issuedMs = Date.now();
    const accessToken = await new SignJWT({ client_id: clientId, scope: scopes.join(' '), issued_ms: issuedMs })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(this.externalUrl)
      .setAudience(resource ?? this.externalUrl)
      .setSubject('mcp-hub-user')
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_S}s`)
      .setJti(crypto.randomBytes(8).toString('base64url'))
      .sign(this.store.privateKey);
    const refreshToken = `rt_${crypto.randomBytes(32).toString('base64url')}`;
    this.store.saveRefreshToken(refreshToken, {
      clientId,
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_S,
      familyId,
      resource
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: scopes.join(' ') || undefined
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.store.publicKey, {
        issuer: this.externalUrl,
        algorithms: ['EdDSA']
      }));
    } catch {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    // Admin-minted API token: same signature and audience rules as an OAuth
    // access token, but revocation lives in its state record — a jti whose
    // record is gone (revoked or expired) is refused even though the JWT
    // itself still verifies.
    if (payload.sub === API_TOKEN_SUBJECT) {
      if (typeof payload.jti !== 'string' || !this.store.getApiToken(payload.jti)) {
        throw new InvalidTokenError('Access token has been revoked');
      }
      const audience = typeof payload.aud === 'string' ? payload.aud : undefined;
      const resource = audience ? this.resolveResourceStrict(audience) : undefined;
      if (!resource) throw new InvalidTokenError('Invalid token audience');
      return { token, clientId: `token:${payload.jti}`, scopes: [], expiresAt: payload.exp, resource };
    }

    if (payload.sub !== 'mcp-hub-user' || typeof payload.client_id !== 'string') {
      throw new InvalidTokenError('Invalid access token claims');
    }
    const audience = typeof payload.aud === 'string' ? payload.aud : undefined;
    const resource = audience && audience !== this.externalUrl ? this.resolveResourceStrict(audience) : undefined;
    if (!audience || (audience !== this.externalUrl && !resource)) throw new InvalidTokenError('Invalid token audience');
    const issuedMs = typeof payload.issued_ms === 'number' ? payload.issued_ms : (payload.iat ?? 0) * 1000;
    const revokedBefore = this.store.getRevokedBefore(payload.client_id);
    if (revokedBefore !== undefined && issuedMs <= revokedBefore) throw new InvalidTokenError('Access token has been revoked');
    return {
      token,
      clientId: payload.client_id,
      scopes: typeof payload.scope === 'string' && payload.scope.length > 0 ? payload.scope.split(' ') : [],
      expiresAt: payload.exp,
      resource
    };
  }

  /** Audience check for already-issued tokens: never falls back to a default. */
  private resolveResourceStrict(audience: string): URL | undefined {
    let url: URL;
    try {
      url = new URL(audience);
    } catch {
      return undefined;
    }
    return this.options.resolveResource?.(url);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record = this.store.getRefreshToken(request.token);
    if (record && record.clientId === client.client_id) this.store.deleteRefreshToken(request.token);
    // Individual JWTs are not stored; the offline admin command revokes all
    // access and refresh tokens for a client through the revokedBefore marker.
  }

  private resolveResource(resource: URL | undefined): URL | undefined {
    if (!resource) {
      // Real clients omit the RFC 8707 parameter (older Codex logins, Google
      // ADK, Gemini Enterprise). DEFAULT_RESOURCE lets the operator route
      // those onto one chosen resource instead of turning them away — the
      // token is still bound, never global.
      if (this.options.defaultResource) return this.options.defaultResource;
      if (this.options.requireResource) throw new InvalidTargetError('A resource indicator is required');
      return undefined;
    }
    const resolved = this.options.resolveResource?.(resource);
    if (!resolved) throw new InvalidTargetError('Unknown or invalid resource');
    return resolved;
  }
}
