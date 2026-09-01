import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { isPrivateAddress, resolvePublicAddress } from './address.js';
import { guardedRequest } from './pinned-fetch.js';
import { isSafeRedirectUri } from './redirect-uri.js';
import { clampDisplayName, logSafe } from './text.js';

// Lives in address.ts now — re-exported because it is part of this module's
// established surface and the test suite reaches for it here.
export { isPrivateAddress };

/**
 * OAuth Client ID Metadata Documents (CIMD,
 * draft-ietf-oauth-client-id-metadata-document-00), the registration mechanism
 * the MCP specification prefers over RFC 7591 dynamic registration.
 *
 * The client hosts its own metadata at a stable HTTPS URL and uses that URL as
 * its client_id; the authorization server fetches and validates the document
 * instead of handing out credentials. Nothing is persisted here — the document
 * is the source of truth and is re-fetched when the cache entry expires, so a
 * client that changes its redirect URIs does not need to re-register.
 *
 * Everything in this file runs against a URL an unauthenticated caller chose,
 * so the fetch is treated as hostile: no redirects, no private addresses, the
 * checked address pinned into the connection, a hard size cap and a short
 * timeout.
 */

/** Draft §6.6 recommends 5 kB; anything larger is not a client metadata document. */
const MAX_DOCUMENT_BYTES = 5 * 1024;
/** A key set is legitimately larger than a metadata document, but not by much:
 *  a handful of RSA keys is a couple of kilobytes. */
const MAX_JWKS_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 200;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 3600_000;
const DEFAULT_TTL_MS = 3600_000;
/** How long a rejected client_id is remembered, so a bad URL cannot be used to
 *  make the hub hammer a third party once per authorization request. */
const NEGATIVE_TTL_MS = 30_000;
/**
 * The per-URL negative cache alone does not bound how often one host can be
 * fetched: the query string is part of the client_id, so `?n=1`, `?n=2` and so
 * on are all distinct identifiers pointing at the same server. Failures are
 * therefore also counted per origin.
 */
const MAX_ORIGIN_FAILURES = 10;
const ORIGIN_FAILURE_WINDOW_MS = 30_000;
const MAX_TRACKED_ORIGINS = 200;

const ASSERTION_SAFE_METHODS = new Set(['none', 'private_key_jwt']);

interface CacheEntry {
  client?: OAuthClientInformationFull;
  expiresAt: number;
}

export interface CimdOptions {
  /** Empty means every https origin is admitted; the consent page is the gate. */
  allowedOrigins?: string[];
  /** Local development and the test suite only: lets the fetch reach loopback. */
  allowPrivateAddresses?: boolean;
  /** Injected by the tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

let fetchOverride: typeof fetch | undefined;

/**
 * Tests serve their metadata documents from a stub here. Client IDs are https
 * URLs by specification and stay that way — the stub is what lets the suite
 * exercise the real fetch path without a certificate authority. Passing
 * undefined restores the global fetch.
 */
export function setCimdFetch(fn: typeof fetch | undefined): void {
  fetchOverride = fn;
}

/**
 * Draft §4.1: the identifier must be an https URL with a path component, no
 * fragment, no credentials and no dot-segments. A `client_id` that fails this
 * is not a metadata document URL at all and is looked up as a locally
 * registered client instead — which is what keeps DCR working beside CIMD.
 */
export function isClientIdMetadataUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hash || url.username || url.password) return false;
  if (url.pathname === '' || url.pathname === '/') return false;
  // Dot segments are checked against the string the client sent, not the
  // parsed URL: the URL parser resolves `/a/../b` away, and a percent-encoded
  // `%2e%2e` survives parsing entirely while still traversing on the server
  // that ultimately serves the document.
  const rawPath = clientId.slice(url.origin.length).split(/[?#]/)[0];
  return !rawPath.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment));
}

export class CimdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  /** Collapses concurrent lookups of the same client_id into one fetch. */
  private readonly inFlight = new Map<string, Promise<OAuthClientInformationFull | undefined>>();
  /** Recent failures per origin, so distinct client_ids on one host cannot be
   *  used to keep fetching it. */
  private readonly originFailures = new Map<string, { count: number; resetAt: number }>();
  private readonly allowedOrigins: Set<string>;

  constructor(private readonly options: CimdOptions = {}) {
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
  }

  /** Undefined for every rejection; the reason is logged, never returned to
   *  the client, so an attacker cannot map out the admission policy. */
  async resolve(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh recency so the eviction below drops genuinely cold entries.
      this.cache.delete(clientId);
      this.cache.set(clientId, cached);
      return cached.client;
    }
    const pending = this.inFlight.get(clientId);
    if (pending) return pending;
    const promise = this.load(clientId).finally(() => this.inFlight.delete(clientId));
    this.inFlight.set(clientId, promise);
    return promise;
  }

  private async load(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    try {
      const url = new URL(clientId);
      if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(url.origin)) {
        return this.reject(clientId, `origin ${url.origin} is not in CIMD_ALLOWED_ORIGINS`);
      }
      if (this.originIsExhausted(url.origin)) {
        // Counting this one too would keep extending the window for as long as
        // the flood lasts, so the block could never lift.
        return this.reject(clientId, `origin ${url.origin} failed too often recently`, false);
      }
      const pinned = await this.assertPublicHost(url.hostname);
      const { document, ttl } = await this.fetchDocument(url, pinned);
      const client = validateDocument(document, clientId);
      this.remember(clientId, client, ttl);
      console.log(`mcp-hub: fetched client metadata document ${logSafe(clientId)} (${logSafe(client.client_name ?? 'unnamed')})`);
      return client;
    } catch (error) {
      return this.reject(clientId, (error as Error).message);
    }
  }

  private reject(clientId: string, reason: string, countAgainstOrigin = true): undefined {
    console.warn(`mcp-hub: refused client metadata document ${logSafe(clientId)}: ${logSafe(reason)}`);
    this.remember(clientId, undefined, NEGATIVE_TTL_MS);
    if (countAgainstOrigin) this.recordOriginFailure(clientId);
    return undefined;
  }

  /** True once one origin has failed often enough that further lookups are
   *  refused without a request until the window passes. */
  private originIsExhausted(origin: string): boolean {
    const entry = this.originFailures.get(origin);
    if (!entry || entry.resetAt <= Date.now()) return false;
    return entry.count >= MAX_ORIGIN_FAILURES;
  }

  private recordOriginFailure(clientId: string): void {
    let origin: string;
    try {
      origin = new URL(clientId).origin;
    } catch {
      return; // not a URL, so there is no origin to hold responsible
    }
    const now = Date.now();
    const entry = this.originFailures.get(origin);
    if (!entry || entry.resetAt <= now) {
      this.originFailures.set(origin, { count: 1, resetAt: now + ORIGIN_FAILURE_WINDOW_MS });
    } else {
      entry.count++;
    }
    if (this.originFailures.size > MAX_TRACKED_ORIGINS) {
      for (const [key, value] of this.originFailures) {
        if (value.resetAt <= now) this.originFailures.delete(key);
      }
      while (this.originFailures.size > MAX_TRACKED_ORIGINS) {
        const oldest = this.originFailures.keys().next();
        if (oldest.done) break;
        this.originFailures.delete(oldest.value);
      }
    }
  }

  private remember(clientId: string, client: OAuthClientInformationFull | undefined, ttl: number): void {
    this.cache.delete(clientId);
    this.cache.set(clientId, { client, expiresAt: Date.now() + ttl });
    // Insertion order is recency order because a hit re-inserts; the oldest
    // key is therefore the least recently used one.
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /**
   * Draft §6.5: refuse every private or loopback address, so a client_id cannot
   * be aimed at the hub's own network or a cloud metadata endpoint. Returns the
   * address the connection is then pinned to.
   */
  private assertPublicHost(hostname: string): Promise<string | undefined> {
    return resolvePublicAddress(hostname, this.options.allowPrivateAddresses);
  }



  /**
   * The same guarded GET the metadata fetch uses, for the one other outbound
   * request a client_id can trigger: the jwks_uri of a private_key_jwt client.
   * Shaped for jose's customFetch hook, which reads only the status and the
   * JSON body.
   */
  readonly safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' && !this.options.allowPrivateAddresses) throw new Error(`${url.origin} is not https`);
    const pinned = await this.assertPublicHost(url.hostname);
    return this.fetchCapped(url, pinned, MAX_JWKS_BYTES, headersFrom(init));
  };

  /**
   * One GET, with every guard applied and the body capped before anyone gets
   * to look at it. The cap is what makes this safe to hand to jose, which
   * would otherwise buffer a key set of any size the client cares to send.
   */
  private async fetchCapped(
    url: URL,
    pinned: string | undefined,
    maxBytes: number,
    headers: Record<string, string>
  ): Promise<Response> {
    const override = this.options.fetchImpl ?? fetchOverride;
    if (!override && pinned) {
      return guardedRequest(url, { pinnedAddress: pinned, headers, timeoutMs: FETCH_TIMEOUT_MS, maxBytes });
    }
    const response = await (override ?? fetch)(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    return capResponse(response, maxBytes);
  }

  private async fetchDocument(url: URL, pinned: string | undefined): Promise<{ document: unknown; ttl: number }> {
    const response = await this.fetchCapped(url, pinned, MAX_DOCUMENT_BYTES, { Accept: 'application/json' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
      throw new Error(`content type ${contentType || 'missing'} is not JSON`);
    }
    let document: unknown;
    try {
      document = JSON.parse(await response.text());
    } catch {
      throw new Error('body is not valid JSON');
    }
    return { document, ttl: cacheTtl(response.headers.get('cache-control')) };
  }
}

/** Re-reads a response through the byte cap and hands back an equivalent one.
 *  A failed status is passed straight through: nothing reads its body. */
async function capResponse(response: Response, limit: number): Promise<Response> {
  if (!response.ok) return response;
  const body = await readCapped(response, limit);
  const headers = new Headers(response.headers);
  // Both would now describe the original transfer rather than this body.
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body, { status: response.status, headers });
}

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const headers = init?.headers;
  if (!headers) return result;
  if (headers instanceof Headers) for (const [key, value] of headers) result[key] = value;
  else if (Array.isArray(headers)) for (const [key, value] of headers) result[key] = value;
  else Object.assign(result, headers);
  return result;
}

/** Reads at most `limit` bytes and refuses anything longer, without buffering
 *  a response an attacker made arbitrarily large. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`document exceeds ${limit} bytes`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`document exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Draft §5: respect the client's cache headers, but never longer than a day
 *  and never so short that every authorization request refetches. */
function cacheTtl(cacheControl: string | null): number {
  if (cacheControl && /(^|,)\s*(no-store|no-cache)\s*(,|$)/i.test(cacheControl)) return MIN_TTL_MS;
  const maxAge = cacheControl?.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  if (!maxAge) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(maxAge[1]) * 1000));
}

/**
 * Turns a fetched document into the client record the rest of the OAuth stack
 * already understands. Throws with a reason for every rejection.
 *
 * No client_secret is ever produced: the SDK's client authentication middleware
 * demands a secret exactly when the stored record has one, so a record without
 * it is what makes a public client work — and the draft forbids symmetric
 * secrets for CIMD clients outright.
 */
export function validateDocument(document: unknown, clientId: string): OAuthClientInformationFull {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('document is not a JSON object');
  const metadata = document as Record<string, unknown>;
  // Simple string comparison, per the draft: a document that could claim any
  // identity would let one origin impersonate another.
  if (metadata.client_id !== clientId) throw new Error('client_id does not match the document URL');
  // The name goes on the consent page, so it is held to what a name can be:
  // one line, and short enough not to displace what sits below it.
  const clientName = clampDisplayName(metadata.client_name);
  if (clientName === undefined) throw new Error('client_name is missing');
  if ('client_secret' in metadata || 'client_secret_expires_at' in metadata) {
    throw new Error('document carries a client_secret');
  }
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined) {
    if (typeof authMethod !== 'string' || !ASSERTION_SAFE_METHODS.has(authMethod)) {
      throw new Error(`token_endpoint_auth_method ${String(authMethod)} needs a shared secret`);
    }
    if (authMethod === 'private_key_jwt' && !metadata.jwks_uri && !metadata.jwks) {
      throw new Error('private_key_jwt without jwks or jwks_uri');
    }
  }
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) throw new Error('redirect_uris is missing or empty');
  for (const uri of redirectUris) {
    if (typeof uri !== 'string') throw new Error('redirect_uris contains a non-string entry');
    // Same rule the MCP specification states for every client: https, or a
    // loopback address for native clients. A metadata document does not get
    // the private-use schemes dynamic registration allows.
    if (!isSafeRedirectUri(uri, { allowPrivateUseSchemes: false })) {
      throw new Error(`redirect_uri ${uri} is neither https nor loopback`);
    }
  }
  return {
    ...(metadata as Record<string, unknown>),
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris as string[]
  } as OAuthClientInformationFull;
}
