import crypto from 'node:crypto';
import type { Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthStore } from './store.js';
import { renderLoginPage } from './login-page.js';

const ACCESS_TOKEN_TTL_S = 24 * 3600;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 60_000;
export const SESSION_COOKIE = 'mcp_hub_session';

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  exp: number;
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export class HubOAuthProvider implements OAuthServerProvider {
  /** Short-lived authorization codes; in-memory on purpose (10 min lifetime). */
  private readonly codes = new Map<string, PendingCode>();

  constructor(
    private readonly store: AuthStore,
    private readonly externalUrl: string
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
    return {
      getClient: clientId => store.getClient(clientId),
      registerClient: client => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: crypto.randomBytes(16).toString('base64url'),
          client_id_issued_at: Math.floor(Date.now() / 1000)
        };
        store.saveClient(full);
        console.log(`mcp-hub: registered OAuth client ${full.client_id} (${full.client_name ?? 'unnamed'})`);
        return full;
      }
    };
  }

  // --- Authorization endpoint ---------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (this.hasValidSession(res.req.headers.cookie)) {
      this.redirectWithCode(client, params, res);
      return;
    }
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      exp: Date.now() + CODE_TTL_MS
    };
    const payload = Buffer.from(JSON.stringify(pending)).toString('base64url');
    res.status(200).type('html').send(renderLoginPage(`${payload}.${sign(payload, this.store.cookieSecret)}`, client.client_name));
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
    params: { redirectUri: string; codeChallenge: string; state?: string; scopes?: string[] },
    res: Response
  ): void {
    const code = crypto.randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + CODE_TTL_MS
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    res.redirect(target.toString());
  }

  // --- Session cookie ------------------------------------------------------

  createSessionCookie(): string {
    const expires = String(Date.now() + SESSION_TTL_MS);
    return `${expires}.${sign(expires, this.store.cookieSecret)}`;
  }

  hasValidSession(cookieHeader: string | undefined): boolean {
    const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (!match) return false;
    const [expires, signature] = decodeURIComponent(match[1]).split('.');
    if (!expires || !signature) return false;
    const expected = sign(expires, this.store.cookieSecret);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    return Number(expires) > Date.now();
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
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.expiresAt < Date.now() || pending.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== pending.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.codes.delete(authorizationCode); // single use
    return this.issueTokens(client.client_id, pending.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const record = this.store.getRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    this.store.deleteRefreshToken(refreshToken); // rotation
    return this.issueTokens(client.client_id, scopes ?? record.scopes);
  }

  private async issueTokens(clientId: string, scopes: string[]): Promise<OAuthTokens> {
    const accessToken = await new SignJWT({ client_id: clientId, scope: scopes.join(' ') })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(this.externalUrl)
      .setAudience(this.externalUrl)
      .setSubject('mcp-hub-user')
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_S}s`)
      .setJti(crypto.randomBytes(8).toString('base64url'))
      .sign(this.store.privateKey);
    const refreshToken = `rt_${crypto.randomBytes(32).toString('base64url')}`;
    this.store.saveRefreshToken(refreshToken, {
      clientId,
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_S
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
        audience: this.externalUrl
      }));
    } catch {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: (payload.client_id as string) ?? 'unknown',
      scopes: typeof payload.scope === 'string' && payload.scope.length > 0 ? payload.scope.split(' ') : [],
      expiresAt: payload.exp
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record = this.store.getRefreshToken(request.token);
    if (record && record.clientId === client.client_id) this.store.deleteRefreshToken(request.token);
    // Access tokens are self-contained 24h JWTs and cannot be revoked individually.
  }
}
