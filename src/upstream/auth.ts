import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, startAuthorization } from '@modelcontextprotocol/client';
import type { OAuthDiscoveryState, OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/client';
import type { RemoteServerConfig } from '../config.js';
import type { AuthStore, UpstreamCredentials, UpstreamLogin } from '../auth/store.js';
import { isPrivateAddress, resolvePublicAddress } from '../auth/address.js';
import { guardedRequest } from '../auth/pinned-fetch.js';
import { logSafe } from '../auth/text.js';
import { UpstreamAuthProvider, callbackUrl, credentialFingerprint, hubClientMetadata } from './provider.js';
import type { UpstreamIdentity } from './provider.js';

/**
 * Everything the hub needs to authenticate itself to one upstream MCP server.
 *
 * The SDK's `auth()` orchestrator is deliberately not used to drive this. Two
 * reasons, both verified against the SDK:
 *
 * It has no single-flight anywhere, so parallel requests that each see a 401
 * each refresh, and an authorization server with rotating refresh tokens
 * revokes the whole family when the losers replay. Refresh is therefore ours.
 *
 * And the `fetch` given to the transport is the *same object* the SDK hands to
 * `auth()` as `fetchFn` — `createFetchWithInit` returns the base fetch
 * unchanged when there is no `requestInit`. So one function has to serve both
 * the MCP data plane and the authorization server, and it is the classifier
 * below that tells them apart.
 */

/** Nothing the hub can do without a human: no credentials, or a refresh token
 *  the upstream will not honour any more. */
export class UpstreamLoginRequiredError extends Error {
  constructor(
    readonly serverName: string,
    reason: string
  ) {
    super(reason);
    this.name = 'UpstreamLoginRequiredError';
  }
}

/** Refresh a little before the token actually dies, to absorb clock skew. */
const EXPIRY_SKEW_S = 60;
/** Discovery is stable; re-deriving it on every connection is pure latency. */
const DISCOVERY_TTL_S = 3600;
const AS_MAX_BYTES = 256 * 1024;
const AS_TIMEOUT_MS = 10_000;

/** Exactly what the SDK caches, plus when — so the TTL below is ours and the
 *  shape stays the one `discoveryState()` has to hand back. */
type StoredDiscovery = OAuthDiscoveryState & { fetchedAt: number };

export class UpstreamAuth {
  readonly identity: UpstreamIdentity;
  /** Which configuration a stored credential has to belong to. */
  readonly fingerprint: string;
  /** Collapses concurrent token work into one request. Without it a burst of
   *  tool calls would each refresh with the same rotating token. */
  private inFlight?: Promise<void>;
  /**
   * Whether the authorization server may live on a private address.
   *
   * Derived from the upstream itself rather than fixed: refusing private
   * addresses outright is right when an untrusted party chose the URL, but here
   * the operator did — and the common self-hosted shape is an internal MCP
   * server behind an internal Keycloak on the same Docker network. A *public*
   * upstream pointing discovery at `169.254.169.254` is still an attack, and
   * still refused.
   */
  private allowPrivate?: boolean;

  constructor(
    serverName: string,
    private readonly config: RemoteServerConfig,
    private readonly store: AuthStore,
    externalUrl: string
  ) {
    this.identity = { serverName, serverUrl: config.url, oauth: config.oauth!, externalUrl };
    this.fingerprint = credentialFingerprint(this.identity);
  }

  provider(options: { pendingCodeVerifier?: string; pendingState?: string } = {}): UpstreamAuthProvider {
    return new UpstreamAuthProvider(this.identity, this.store, options);
  }

  private get record(): UpstreamCredentials | undefined {
    return this.store.getUpstreamCredentials(this.identity.serverName, this.fingerprint);
  }

  /** The full pair including the refresh token: this class is the only thing
   *  allowed to spend it, which is why the provider withholds it. */
  private tokens(): OAuthTokens | undefined {
    return this.record?.tokens as OAuthTokens | undefined;
  }

  /** The public key the upstream needs, but only when we sign assertions. */
  private async publicJwkIfNeeded() {
    return this.identity.oauth.clientAuth === 'private_key_jwt' ? await this.provider().publicJwk() : undefined;
  }

  /** True when the upstream's own host is private, so its authorization server
   *  is allowed to be too. Resolved once. */
  private async privateAllowed(): Promise<boolean> {
    if (this.allowPrivate === undefined) {
      const hostname = new URL(this.identity.serverUrl).hostname.replace(/^\[|\]$/g, '');
      try {
        this.allowPrivate = isPrivateAddress(hostname) || (await resolvePublicAddress(hostname).then(() => false, () => true));
      } catch {
        this.allowPrivate = true;
      }
    }
    return this.allowPrivate;
  }

  /** The guarded fetch used for every authorization-server request: no static
   *  headers, no bearer, address-checked, pinned, capped, no redirects. */
  private async asFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const allowPrivate = await this.privateAllowed();
    const pinned = await resolvePublicAddress(url.hostname, allowPrivate);
    if (!pinned) {
      return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(AS_TIMEOUT_MS) });
    }
    return guardedRequest(url, {
      pinnedAddress: pinned,
      method: init?.method ?? 'GET',
      headers: toRecord(init?.headers),
      body: typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
      timeoutMs: AS_TIMEOUT_MS,
      maxBytes: AS_MAX_BYTES
    });
  }

  private readonly boundAsFetch: typeof fetch = (input, init) => this.asFetch(input, init);

  // --- Discovery and client identity ---------------------------------------

  async discover(force = false): Promise<StoredDiscovery> {
    const cached = this.record?.discovery as StoredDiscovery | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!force && cached?.authorizationServerUrl && now - cached.fetchedAt < DISCOVERY_TTL_S) return cached;
    const info = await discoverOAuthServerInfo(this.identity.serverUrl, { fetchFn: this.boundAsFetch });
    const discovery: StoredDiscovery = { ...info, fetchedAt: now };
    this.provider().saveDiscoveryState(discovery);
    return discovery;
  }

  /**
   * The client_id this hub uses with this upstream, registering dynamically the
   * first time when that is the configured mode.
   */
  async clientInformation(discovery: StoredDiscovery): Promise<OAuthClientInformation> {
    const { oauth } = this.identity;
    if (oauth.mode === 'static') {
      return { client_id: oauth.clientId!, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}) };
    }
    const existing = this.record;
    if (existing?.clientId) {
      return { client_id: existing.clientId, ...(existing.clientSecret ? { client_secret: existing.clientSecret } : {}) };
    }
    if (oauth.mode === 'cimd') {
      if (discovery.authorizationServerMetadata?.client_id_metadata_document_supported !== true) {
        throw new UpstreamLoginRequiredError(
          this.identity.serverName,
          'the upstream does not accept client ID metadata documents; use mode "dcr" or "static"'
        );
      }
      const clientId = this.provider().clientMetadataUrl!;
      this.provider().saveClientInformation({ client_id: clientId });
      return { client_id: clientId };
    }
    const registered = await this.registerDynamically(discovery);
    this.provider().saveClientInformation(registered);
    console.log(`mcp-hub: registered with ${logSafe(discovery.authorizationServerUrl)} for upstream "${logSafe(this.identity.serverName)}"`);
    return registered;
  }

  /**
   * RFC 7591 registration, done here rather than through the SDK's
   * `registerClient`.
   *
   * That helper parses the response with `OAuthClientInformationFullSchema`,
   * which strips unknown fields — including `registration_access_token` and
   * `registration_client_uri`. Those are exactly what `upstream logout` needs
   * to delete the registration again (RFC 7592), so they have to survive.
   */
  private async registerDynamically(discovery: StoredDiscovery): Promise<OAuthClientInformation & Record<string, unknown>> {
    const endpoint = discovery.authorizationServerMetadata?.registration_endpoint;
    if (!endpoint) {
      throw new UpstreamLoginRequiredError(
        this.identity.serverName,
        'the upstream offers no dynamic client registration; use mode "static" with a client_id it issued you'
      );
    }
    const response = await this.asFetch(new URL(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(hubClientMetadata(this.identity, await this.publicJwkIfNeeded()))
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new UpstreamLoginRequiredError(
        this.identity.serverName,
        `dynamic registration failed with HTTP ${response.status}${detail ? `: ${errorCode(detail)}` : ''}`
      );
    }
    const registered = (await response.json()) as OAuthClientInformation & Record<string, unknown>;
    if (typeof registered.client_id !== 'string') {
      throw new UpstreamLoginRequiredError(this.identity.serverName, 'the upstream returned a registration without a client_id');
    }
    return registered;
  }

  // --- Tokens ---------------------------------------------------------------

  /** Seconds until the stored access token should be replaced; negative when it
   *  already should have been. Infinity when the upstream gave no expiry. */
  private secondsLeft(): number {
    const validUntil = this.record?.accessTokenValidUntil;
    if (validUntil === undefined) return Number.POSITIVE_INFINITY;
    return validUntil - EXPIRY_SKEW_S - Math.floor(Date.now() / 1000);
  }

  /**
   * Makes sure a usable access token is on disk, doing nothing when one already
   * is. Every caller funnels through here, so a burst produces one request.
   *
   * `staleAccessToken` is what a 401 handler passes: the token that was just
   * refused. If the stored token is no longer that one, somebody else has
   * already replaced it and there is nothing to do — without that check a
   * straggler arriving just after a refresh completed would spend the rotating
   * refresh token a second time, which is exactly what the upstream treats as
   * replay.
   */
  async prepare(options: { force?: boolean; staleAccessToken?: string } = {}): Promise<void> {
    const usable = Boolean(this.tokens()?.access_token) && this.secondsLeft() > 0;
    if (options.staleAccessToken !== undefined) {
      if (this.tokens()?.access_token !== options.staleAccessToken) return;
    } else if (!options.force && usable) {
      return;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.obtain(true).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async obtain(force: boolean): Promise<void> {
    // Another process may have refreshed while we queued; adopt rather than
    // spend the refresh token a second time.
    if (!force && this.tokens()?.access_token && this.secondsLeft() > 0) return;
    const discovery = await this.discover();
    const clientInformation = await this.clientInformation(discovery);
    const resource = discovery.resourceMetadata?.resource ? new URL(discovery.resourceMetadata.resource) : undefined;

    if (this.identity.oauth.grant === 'client_credentials') {
      const tokens = await this.fetchClientCredentialsTokens(discovery, clientInformation, resource);
      this.provider().saveTokens(tokens);
      return;
    }

    const refreshToken = this.tokens()?.refresh_token;
    if (!refreshToken) {
      throw new UpstreamLoginRequiredError(this.identity.serverName, 'no upstream tokens are stored');
    }
    try {
      const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation,
        refreshToken,
        resource,
        addClientAuthentication: this.provider().addClientAuthentication,
        fetchFn: this.boundAsFetch
      });
      this.provider().saveTokens(tokens);
    } catch (error) {
      // A refresh token the upstream will not honour cannot be recovered from
      // without a human, so say so rather than restarting forever.
      throw new UpstreamLoginRequiredError(this.identity.serverName, `refresh failed: ${(error as Error).message}`);
    }
  }

  private async fetchClientCredentialsTokens(
    discovery: StoredDiscovery,
    clientInformation: OAuthClientInformation,
    resource: URL | undefined
  ): Promise<OAuthTokens> {
    // The SDK has no client_credentials helper of its own that we can call
    // without going through auth(); the request is three fields.
    const provider = this.provider();
    const params = provider.prepareTokenRequest()!;
    if (resource) params.set('resource', resource.href);
    const tokenUrl = new URL(discovery.authorizationServerMetadata?.token_endpoint ?? new URL('/token', discovery.authorizationServerUrl).href);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    };
    if (this.identity.oauth.clientAuth === 'private_key_jwt') {
      // Same hook the authorization-code paths use, so there is one place that
      // decides how this hub proves itself.
      await provider.addClientAuthentication(new Headers(), params, tokenUrl);
    } else if (clientInformation.client_secret) {
      const basic = Buffer.from(`${clientInformation.client_id}:${clientInformation.client_secret}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    } else {
      params.set('client_id', clientInformation.client_id);
    }
    const response = await this.asFetch(tokenUrl, { method: 'POST', headers, body: params.toString() });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new UpstreamLoginRequiredError(
        this.identity.serverName,
        `client_credentials token request failed with HTTP ${response.status}${detail ? `: ${errorCode(detail)}` : ''}`
      );
    }
    return (await response.json()) as OAuthTokens;
  }

  // --- The interactive login, driven by the admin CLI -----------------------

  /** Everything the operator has to be sent to, plus what the callback will
   *  need to finish. The caller persists the login and prints the URL. */
  async startLogin(signedState: string): Promise<{ authorizationUrl: string; login: Omit<UpstreamLogin, 'expiresAt'> }> {
    const discovery = await this.discover(true);
    const clientInformation = await this.clientInformation(discovery);
    const scope = this.identity.oauth.scopes.join(' ') || undefined;
    const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      redirectUrl: callbackUrl(this.identity.externalUrl),
      scope,
      state: signedState,
      resource: discovery.resourceMetadata?.resource ? new URL(discovery.resourceMetadata.resource) : undefined
    });
    return {
      authorizationUrl: authorizationUrl.href,
      login: {
        serverName: this.identity.serverName,
        codeVerifier,
        authorizationServerUrl: discovery.authorizationServerUrl,
        ...(discovery.resourceMetadata?.resource ? { resourceMetadataUrl: discovery.resourceMetadata.resource } : {}),
        ...(scope ? { scope } : {})
      }
    };
  }

  /** Redeems the code the upstream sent back. */
  async finishLogin(login: UpstreamLogin, code: string): Promise<void> {
    const discovery = await this.discover();
    const clientInformation = await this.clientInformation(discovery);
    const tokens = await exchangeAuthorization(login.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier: login.codeVerifier,
      redirectUri: callbackUrl(this.identity.externalUrl),
      resource: discovery.resourceMetadata?.resource ? new URL(discovery.resourceMetadata.resource) : undefined,
      addClientAuthentication: this.provider().addClientAuthentication,
      fetchFn: this.boundAsFetch
    });
    this.provider().saveTokens(tokens);
  }

  /**
   * Best effort: tell the upstream to forget the token (RFC 7009) and, for a
   * dynamic registration, the registration itself (RFC 7592). Neither is
   * offered by the SDK, and neither may stop the local record from going away.
   */
  async revokeRemotely(): Promise<string[]> {
    const problems: string[] = [];
    const record = this.record;
    if (!record) return problems;
    const discovery = record.discovery as StoredDiscovery | undefined;
    // Declared by RFC 8414 and carried by the SDK's loose metadata schema, but
    // absent from its TypeScript type.
    const revocationEndpoint = (discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
    const tokens = record.tokens as OAuthTokens | undefined;
    if (revocationEndpoint && tokens?.refresh_token) {
      try {
        const body = new URLSearchParams({ token: tokens.refresh_token, token_type_hint: 'refresh_token' });
        if (record.clientId) body.set('client_id', record.clientId);
        if (record.clientSecret) body.set('client_secret', record.clientSecret);
        await this.asFetch(new URL(revocationEndpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
      } catch (error) {
        problems.push(`token revocation failed: ${(error as Error).message}`);
      }
    }
    if (record.registrationClientUri && record.registrationAccessToken) {
      try {
        await this.asFetch(new URL(record.registrationClientUri), {
          method: 'DELETE',
          headers: { authorization: `Bearer ${record.registrationAccessToken}` }
        });
      } catch (error) {
        problems.push(`registration delete failed: ${(error as Error).message}`);
      }
    }
    return problems;
  }

  /**
   * The one fetch the transport gets.
   *
   * Requests to the upstream itself carry the configured headers and the bearer
   * and go out on the ordinary fetch, because the data plane streams. Anything
   * aimed at the authorization server takes the guarded path instead, and is
   * never shown a header or a token belonging to the upstream.
   */
  createFetch(): typeof fetch {
    const upstreamOrigin = new URL(this.identity.serverUrl).origin;
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const isControlPlane = url.origin !== upstreamOrigin || url.pathname.startsWith('/.well-known/');
      if (isControlPlane) return this.asFetch(url, init);

      const send = async (): Promise<{ response: Response; token?: string }> => {
        const headers = new Headers(init?.headers);
        const token = this.tokens()?.access_token;
        if (token) headers.set('authorization', `Bearer ${token}`);
        for (const [key, value] of Object.entries(this.config.headers)) {
          if (!headers.has(key)) headers.set(key, value);
        }
        return { response: await fetch(url, { ...init, headers }), token };
      };

      const first = await send();
      if (first.response.status !== 401) return first.response;
      // Handled here rather than by the SDK: its recovery has no single flight,
      // so parallel 401s would each refresh. Passing the token that was refused
      // means a caller whose token was already replaced skips straight to the
      // retry instead of refreshing again.
      try {
        await this.prepare({ staleAccessToken: first.token });
      } catch {
        // Leave the 401 standing; the supervisor turns it into `unauthorized`.
        return first.response;
      }
      return (await send()).response;
    };
  }
}

function toRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) for (const [key, value] of headers) result[key] = value;
  else if (Array.isArray(headers)) for (const [key, value] of headers) result[key] = value;
  else Object.assign(result, headers);
  return result;
}

/** An OAuth error body carries a code worth logging and a description that may
 *  carry anything at all; only the code is repeated. */
function errorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : 'unknown_error';
  } catch {
    return 'unknown_error';
  }
}
