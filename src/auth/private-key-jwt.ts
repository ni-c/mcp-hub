import type { Request, Response, NextFunction } from 'express';
import { createLocalJWKSet, createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { CimdResolver, isClientIdMetadataUrl } from './cimd.js';
import { logSafe } from './text.js';

/**
 * RFC 7523 client authentication for Client ID Metadata Document clients.
 *
 * A CIMD client cannot hold a shared secret, so a confidential one proves
 * itself with a JWT signed by a key published in its own metadata document.
 * ChatGPT's connectors take exactly this path.
 *
 * This runs ahead of the SDK's token handler and, on success, rewrites the
 * request body into the shape that handler already understands: a client_id
 * and no secret. The SDK then looks the client up through the same
 * clientsStore.getClient() that CIMD hooks into, so authorization, token and
 * refresh all agree on one client record.
 */

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** RFC 7523 §3: assertions are single-use and short-lived. Anything longer is
 *  a replay window we would have to remember. */
const MAX_ASSERTION_LIFETIME_S = 5 * 60;
const CLOCK_TOLERANCE_S = 60;
const MAX_REPLAY_ENTRIES = 5_000;

const SUPPORTED_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** Remote key sets are cached per jwks_uri, and the URI comes out of a document
 *  an unauthenticated caller pointed us at — so the cache needs a ceiling. */
const MAX_REMOTE_KEY_SETS = 50;

/** jti values already redeemed, dropped once the assertion that carried them
 *  could no longer be valid anyway. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = MAX_REPLAY_ENTRIES) {}

  /** False when this jti has been used before. */
  admit(jti: string, expiresAtMs: number): boolean {
    this.sweep();
    if (this.seen.has(jti)) return false;
    // A flood of distinct assertions must not grow this without bound; the
    // sweep only removes expired ones.
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(jti, expiresAtMs);
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [jti, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(jti);
    }
  }
}

export interface PrivateKeyJwtOptions {
  resolver: CimdResolver;
  /** Issuer identifier; also accepted as the assertion audience. */
  externalUrl: string;
  tokenEndpoint: string;
}

export function privateKeyJwtAuth(options: PrivateKeyJwtOptions) {
  const replay = new ReplayGuard();
  const remoteKeys = new Map<string, JWTVerifyGetKey>();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined;
    const assertion = body?.client_assertion;
    const refuse = (reason: string): void => {
      console.warn(`mcp-hub: client assertion refused: ${logSafe(reason)}`);
      res.status(400).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
    };
    if (body?.client_assertion_type === undefined && assertion === undefined) {
      // Nothing to verify — but "no credentials" must not be a way to be
      // treated as a public client. The SDK's client authentication only ever
      // looks for a client_secret, and a CIMD client never has one, so a
      // confidential client that simply omits its assertion would otherwise be
      // let through on its client_id alone. That is the whole guarantee
      // private_key_jwt exists to provide.
      if (!(await requiresAssertion(body?.client_id, options.resolver))) {
        next();
        return;
      }
      refuse(`${String(body?.client_id)} declares private_key_jwt and must present a client assertion`);
      return;
    }
    if (body?.client_assertion_type !== CLIENT_ASSERTION_TYPE) {
      refuse(`unsupported client_assertion_type ${String(body?.client_assertion_type)}`);
      return;
    }
    if (typeof assertion !== 'string' || assertion.length === 0) {
      refuse('client_assertion is missing');
      return;
    }
    try {
      const clientId = clientIdFromAssertion(assertion, typeof body.client_id === 'string' ? body.client_id : undefined);
      if (!isClientIdMetadataUrl(clientId)) {
        refuse('client assertions are only accepted for client ID metadata documents');
        return;
      }
      const client = await options.resolver.resolve(clientId);
      if (!client) {
        refuse(`no usable metadata document for ${clientId}`);
        return;
      }
      if (client.token_endpoint_auth_method !== 'private_key_jwt') {
        refuse(`${clientId} does not declare private_key_jwt`);
        return;
      }
      const keys = keySource(client, options.resolver, remoteKeys);
      const { payload } = await jwtVerify(assertion, keys, {
        issuer: clientId,
        subject: clientId,
        algorithms: SUPPORTED_ALGS,
        clockTolerance: CLOCK_TOLERANCE_S
      });
      const failure = checkClaims(payload, options);
      if (failure) {
        refuse(failure);
        return;
      }
      if (!replay.admit(payload.jti!, payload.exp! * 1000)) {
        refuse(`jti ${payload.jti} was already used`);
        return;
      }
      // Hand the SDK a plain public-client request. The stored record carries
      // no client_secret, so its middleware asks for none.
      delete body.client_assertion;
      delete body.client_assertion_type;
      body.client_id = clientId;
      next();
    } catch (error) {
      refuse((error as Error).message);
    }
  };
}

/**
 * RFC 7523 allows the client_id form parameter to be omitted when the
 * assertion carries the identity. Reading `iss` before verification is safe
 * because it only selects which keys to verify against — a forged value
 * resolves to a document whose keys will not match the signature.
 */
function clientIdFromAssertion(assertion: string, formClientId: string | undefined): string {
  const segments = assertion.split('.');
  if (segments.length !== 3) throw new Error('client_assertion is not a JWS');
  let claims: { iss?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('client_assertion payload is not JSON');
  }
  if (typeof claims.iss !== 'string' || claims.iss.length === 0) throw new Error('client_assertion has no iss');
  if (formClientId !== undefined && formClientId !== claims.iss) throw new Error('client_id does not match the assertion issuer');
  return claims.iss;
}

/**
 * Whether this client_id belongs to a client that promised to authenticate
 * with an assertion. Only a metadata document can make that promise: a
 * dynamically registered client either holds a secret the SDK checks, or is
 * public by registration.
 */
async function requiresAssertion(clientId: unknown, resolver: CimdResolver): Promise<boolean> {
  if (typeof clientId !== 'string' || !isClientIdMetadataUrl(clientId)) return false;
  // resolve() answers undefined for anything it refuses, and an unknown client
  // is the SDK's to reject with its own invalid_client.
  const client = await resolver.resolve(clientId);
  return client?.token_endpoint_auth_method === 'private_key_jwt';
}

function keySource(
  client: { jwks?: unknown; jwks_uri?: unknown },
  resolver: CimdResolver,
  remoteKeys: Map<string, JWTVerifyGetKey>
): JWTVerifyGetKey {
  // An inline JWKS needs no second request, so it is preferred when present.
  if (client.jwks && typeof client.jwks === 'object') {
    return createLocalJWKSet(client.jwks as Parameters<typeof createLocalJWKSet>[0]);
  }
  if (typeof client.jwks_uri !== 'string') throw new Error('client publishes neither jwks nor jwks_uri');
  const uri = client.jwks_uri;
  const cached = remoteKeys.get(uri);
  if (cached) {
    // Re-insert so insertion order stays recency order for the eviction below.
    remoteKeys.delete(uri);
    remoteKeys.set(uri, cached);
    return cached;
  }
  // jose caches the key set and refetches on an unknown kid; the fetch goes
  // through the same SSRF guard and byte cap as the metadata document.
  const keys = createRemoteJWKSet(new URL(uri), { [customFetch]: resolver.safeFetch });
  remoteKeys.set(uri, keys);
  // This entry is created before the signature is checked, so anyone able to
  // reach /token can add one. Drop the coldest instead of growing forever.
  while (remoteKeys.size > MAX_REMOTE_KEY_SETS) {
    const oldest = remoteKeys.keys().next();
    if (oldest.done) break;
    remoteKeys.delete(oldest.value);
  }
  return keys;
}

/** Everything jwtVerify does not check for us. */
function checkClaims(payload: JWTPayload, options: PrivateKeyJwtOptions): string | undefined {
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud];
  // The token endpoint is what RFC 7523 asks for; the issuer identifier is what
  // several clients send instead, and OpenID Connect blesses it.
  if (!audiences.includes(options.tokenEndpoint) && !audiences.includes(options.externalUrl)) {
    return `aud ${audiences.join(',') || 'missing'} is neither the token endpoint nor the issuer`;
  }
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) return 'assertion has no jti';
  if (typeof payload.exp !== 'number') return 'assertion has no exp';
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp > now + MAX_ASSERTION_LIFETIME_S + CLOCK_TOLERANCE_S) return 'assertion lifetime exceeds five minutes';
  return undefined;
}
