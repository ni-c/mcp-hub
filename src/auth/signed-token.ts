import crypto from 'node:crypto';

/**
 * Short-lived values the hub hands to a browser and expects back unchanged.
 *
 * Used for the login/consent form token, the session cookie, the consent CSRF
 * token and the `state` of an outbound OAuth login. All of them share one
 * property: the hub must recognise its own value without storing it, and must
 * not be talked into accepting someone else's.
 *
 * The key throughout is `AuthStore.cookieSecret`.
 */

export function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Constant-time comparison against the expected signature.
 *
 * The length check is not an optimisation — `timingSafeEqual` throws on
 * mismatched lengths, so a value of the wrong length would otherwise be an
 * exception rather than a rejection.
 */
export function signatureMatches(value: string, signature: string, secret: string): boolean {
  const expected = sign(value, secret);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** `base64url(json).signature` — everything the caller needs, carried by the
 *  browser instead of by the hub. */
export function signPayload(payload: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Undefined for anything that was not signed with this secret, or is not the
 *  shape it claims. Never throws on malformed input. */
export function readSignedPayload<T>(token: string, secret: string): T | undefined {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return undefined;
  if (!signatureMatches(encoded, signature, secret)) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}
