import crypto from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import type { JWK } from 'jose';
import type { OAuthClientProvider, OAuthDiscoveryState, OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/client';
import type { UpstreamOAuthConfig } from '../config.js';
import type { AuthStore, UpstreamCredentials } from '../auth/store.js';
import { sign } from '../auth/signed-token.js';
import { VERSION } from '../version.js';

/**
 * The hub as an OAuth *client*, for one upstream MCP server.
 *
 * The SDK drives the protocol; this supplies the identity and the storage. Two
 * things shape the design:
 *
 * The transport is rebuilt on every connection attempt (`buildRemoteTransport`
 * runs inside `start()`), so nothing durable may live in a field here. Every
 * read goes to the store, which is also how a token written by
 * `mcp-hub-admin upstream login` in another process reaches a running hub —
 * `reloadIfChanged()` is a single stat.
 *
 * And `redirectUrl` returning `undefined` is what selects the SDK's
 * non-interactive path, so it is the switch between the two grants rather than
 * a mere detail.
 */

/** Where the upstream sends the operator's browser back to. */
export const UPSTREAM_CALLBACK_PATH = 'upstream/callback';
/** Where the hub publishes a client metadata document, one per upstream. */
export const UPSTREAM_CLIENT_METADATA_PREFIX = '.well-known/mcp-hub-client';

export interface UpstreamIdentity {
  serverName: string;
  /** The MCP endpoint; the SDK discovers the authorization server from it. */
  serverUrl: string;
  oauth: UpstreamOAuthConfig;
  /** Issuer of this hub, needed for the redirect URI and the CIMD document. */
  externalUrl: string;
}

/**
 * Identifies the configuration a stored credential belongs to. Change the URL,
 * the client or the scopes and the old tokens describe an identity the upstream
 * no longer knows — presenting them would at best fail confusingly. Deliberately
 * excludes everything that does not affect identity, so renaming a header does
 * not force a new login.
 */
export function credentialFingerprint(identity: UpstreamIdentity): string {
  const { oauth } = identity;
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([identity.serverUrl, oauth.mode, oauth.grant, oauth.clientId ?? null, [...oauth.scopes].sort()])
    )
    .digest('hex');
}

export function callbackUrl(externalUrl: string): string {
  return new URL(UPSTREAM_CALLBACK_PATH, externalUrl).href;
}

/**
 * The identifier a client metadata document is published under.
 *
 * Derived from the server name rather than being it. The document is fetched by
 * a third party and is therefore unauthenticated, and `/health` is behind bearer
 * auth precisely so that the deployment's topology is not public — a document at
 * `/…/paperless.json` would hand that back. Losing `cookieSecret` already
 * invalidates every session and approval, so deriving from it costs nothing.
 */
export function clientDocumentId(serverName: string, secret: string): string {
  return sign(`upstream-client:${serverName}`, secret).slice(0, 22);
}

/** One document per upstream: two servers using `cimd` may want different
 *  scopes, and a shared document would give the second one the first's. */
export function clientMetadataUrl(externalUrl: string, serverName: string, secret: string): string {
  return new URL(`${UPSTREAM_CLIENT_METADATA_PREFIX}/${clientDocumentId(serverName, secret)}.json`, externalUrl).href;
}

/** The document the hub publishes about itself when an upstream supports CIMD,
 *  and the body it sends when registering dynamically. Both are the same thing. */
export function hubClientMetadata(identity: UpstreamIdentity, publicJwk?: JWK): OAuthClientMetadata {
  const interactive = identity.oauth.grant === 'authorization_code';
  const usesKey = identity.oauth.clientAuth === 'private_key_jwt';
  return {
    client_name: `mcp-hub ${VERSION}`,
    client_uri: identity.externalUrl,
    // A client_credentials client has no redirect at all, and the SDK's own
    // provider sets an empty array for exactly that case.
    redirect_uris: interactive ? [callbackUrl(identity.externalUrl)] : [],
    grant_types: interactive ? ['authorization_code', 'refresh_token'] : ['client_credentials'],
    response_types: ['code'],
    token_endpoint_auth_method: usesKey ? 'private_key_jwt' : identity.oauth.clientSecret ? 'client_secret_basic' : 'none',
    // The upstream verifies our assertions against this, so it has to travel
    // with the document and with the registration request.
    ...(usesKey && publicJwk ? { jwks: { keys: [publicJwk] } } : {}),
    ...(identity.oauth.scopes.length > 0 ? { scope: identity.oauth.scopes.join(' ') } : {})
  };
}

/** RFC 7523 §2.2: assertions are single-use and short-lived. */
const ASSERTION_LIFETIME_S = 300;

export interface UpstreamProviderOptions {
  /** Set while finishing a login: the verifier that was saved when it started. */
  pendingCodeVerifier?: string;
}

export class UpstreamAuthProvider implements OAuthClientProvider {
  /** Captured rather than followed: this process has no browser, and the URL is
   *  what `upstream login` prints for the operator. */
  authorizationUrl?: string;
  /** The SDK hands the verifier over during startAuthorization; the caller
   *  persists it alongside the login it is about to record. */
  issuedCodeVerifier?: string;

  private readonly fingerprint: string;

  constructor(
    readonly identity: UpstreamIdentity,
    private readonly store: AuthStore,
    private readonly options: UpstreamProviderOptions = {}
  ) {
    this.fingerprint = credentialFingerprint(identity);
  }

  private get record(): UpstreamCredentials | undefined {
    return this.store.getUpstreamCredentials(this.identity.serverName, this.fingerprint);
  }

  /** Merges into whatever is on disk right now, so a concurrent writer — the
   *  admin CLI, or the hub itself — is not clobbered. */
  private patch(changes: Partial<UpstreamCredentials>): void {
    const fingerprint = this.fingerprint;
    this.store.updateUpstreamCredentials(this.identity.serverName, current => ({
      // A record from a superseded configuration is replaced, not merged into.
      ...(current?.fingerprint === fingerprint ? current : {}),
      fingerprint,
      obtainedAt: Math.floor(Date.now() / 1000),
      ...changes
    }));
  }

  // --- OAuthClientProvider -------------------------------------------------

  get redirectUrl(): string | undefined {
    // Undefined is the SDK's switch into the non-interactive flow.
    return this.identity.oauth.grant === 'authorization_code' ? callbackUrl(this.identity.externalUrl) : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return hubClientMetadata(this.identity);
  }

  /** Only set for `mode: "cimd"`. The SDK uses it as the client_id, but only if
   *  the upstream advertises support; otherwise it falls back to registering. */
  get clientMetadataUrl(): string | undefined {
    if (this.identity.oauth.mode !== 'cimd') return undefined;
    return clientMetadataUrl(this.identity.externalUrl, this.identity.serverName, this.store.cookieSecret);
  }

  clientInformation(): OAuthClientInformation | undefined {
    // Configured credentials win: with them there is nothing to register, and
    // the SDK skips both CIMD and dynamic registration.
    if (this.identity.oauth.mode === 'static') {
      return {
        client_id: this.identity.oauth.clientId!,
        ...(this.identity.oauth.clientSecret ? { client_secret: this.identity.oauth.clientSecret } : {})
      };
    }
    const record = this.record;
    if (!record?.clientId) return undefined;
    return {
      client_id: record.clientId,
      ...(record.clientSecret ? { client_secret: record.clientSecret } : {})
    };
  }

  saveClientInformation(information: OAuthClientInformation & Record<string, unknown>): void {
    this.patch({
      clientId: information.client_id,
      ...(typeof information.client_secret === 'string' ? { clientSecret: information.client_secret } : {}),
      // RFC 7592 credentials, when the upstream issued them — what `upstream
      // logout` needs to delete the registration again.
      ...(typeof information.registration_access_token === 'string'
        ? { registrationAccessToken: information.registration_access_token }
        : {}),
      ...(typeof information.registration_client_uri === 'string'
        ? { registrationClientUri: information.registration_client_uri }
        : {})
    });
  }

  /**
   * The access token, deliberately without the refresh token.
   *
   * That withholding is the point: the SDK refreshes reactively on any 401 and
   * has no single-flight, so a burst of parallel requests would each spend the
   * same rotating refresh token and an upstream that detects reuse would revoke
   * the whole family. Refresh belongs to UpstreamAuth, which serializes it.
   */
  tokens(): OAuthTokens | undefined {
    const stored = this.record?.tokens as OAuthTokens | undefined;
    if (!stored) return undefined;
    const { refresh_token: _withheld, ...rest } = stored;
    return rest as OAuthTokens;
  }

  /** The full pair, for the one caller that is allowed to spend it. */
  storedTokens(): OAuthTokens | undefined {
    return this.record?.tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
    this.patch({
      tokens: tokens as unknown as Record<string, unknown>,
      ...(expiresIn !== undefined ? { accessTokenValidUntil: Math.floor(Date.now() / 1000) + expiresIn } : {})
    });
  }

  /** Never actually redirects: there is no user agent in this process. The URL
   *  is handed to whoever started the login to print. */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl.href;
  }

  saveCodeVerifier(codeVerifier: string): void {
    // Kept in memory only. The caller stores it with the pending login, because
    // the browser round-trip may finish in a different process.
    this.issuedCodeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    const verifier = this.options.pendingCodeVerifier ?? this.issuedCodeVerifier;
    if (!verifier) throw new Error('no PKCE verifier for this login; start it again');
    return verifier;
  }

  /** Client credentials for the non-interactive grant. Without this the SDK
   *  would try an authorization-code exchange and fail for want of a code. */
  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.identity.oauth.grant !== 'client_credentials') return undefined;
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const requested = scope ?? this.identity.oauth.scopes.join(' ');
    if (requested) params.set('scope', requested);
    return params;
  }

  /**
   * The SDK's recovery path: on `invalid_grant` it clears tokens and retries, on
   * `invalid_client` it clears everything. Without this a dead refresh token
   * loops into the same failure and then throws.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this.issuedCodeVerifier = undefined;
      return;
    }
    if (scope === 'all') {
      this.store.forgetUpstreamCredentials(this.identity.serverName);
      return;
    }
    const record = this.record;
    if (!record) return;
    const cleared: UpstreamCredentials = { ...record };
    if (scope === 'tokens') {
      delete cleared.tokens;
      delete cleared.accessTokenValidUntil;
    }
    if (scope === 'client') {
      delete cleared.clientId;
      delete cleared.clientSecret;
      delete cleared.registrationAccessToken;
      delete cleared.registrationClientUri;
    }
    if (scope === 'discovery') delete cleared.discovery;
    this.store.updateUpstreamCredentials(this.identity.serverName, () => cleared);
  }

  /** The public half of the outbound signing key, for the document the upstream
   *  fetches. */
  async publicJwk(): Promise<JWK> {
    const jwk = await exportJWK(crypto.createPublicKey(this.store.upstreamPrivateKey));
    return { ...jwk, use: 'sig', alg: 'EdDSA', kid: 'mcp-hub-upstream' };
  }

  /**
   * RFC 7523 client authentication, replacing the SDK's built-in choice.
   *
   * The SDK picks between `client_secret_basic`, `client_secret_post` and
   * `none`; it has no assertion path at all. Providing this hook takes the
   * decision away from it entirely, which is also why the shared-secret cases
   * fall through to doing nothing — the SDK's own logic is right for those.
   */
  readonly addClientAuthentication = async (
    _headers: Headers,
    params: URLSearchParams,
    url: string | URL
  ): Promise<void> => {
    if (this.identity.oauth.clientAuth !== 'private_key_jwt') return;
    const clientId = this.clientInformation()?.client_id;
    if (!clientId) throw new Error('cannot sign a client assertion before the client_id is known');
    params.set('client_id', clientId);
    params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    params.set('client_assertion', await this.signAssertion(clientId, String(url)));
  };

  private async signAssertion(clientId: string, audience: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'mcp-hub-upstream' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${ASSERTION_LIFETIME_S}s`)
      .setJti(crypto.randomBytes(16).toString('base64url'))
      .sign(this.store.upstreamPrivateKey);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.patch({ discovery: state as unknown as Record<string, unknown> });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.record?.discovery as OAuthDiscoveryState | undefined;
  }
}
