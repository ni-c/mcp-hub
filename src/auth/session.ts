import { sign, signatureMatches } from './signed-token.js';

/** Deliberately short: it only has to outlive a connector's authorization. */
export const SESSION_TTL_MS = 30 * 60_000;
export const SESSION_COOKIE = 'mcp_hub_session';

/**
 * The cookie's name, which behind HTTPS carries the `__Host-` prefix.
 *
 * The prefix is a promise the browser enforces: such a cookie is only accepted
 * from a secure origin, with `Path=/` and without a `Domain`, and can therefore
 * not be planted by a sibling subdomain or over plain http on the same host.
 * The value is signed either way, so a planted cookie could not be a forged
 * session — but it could be a *real* one an attacker obtained, fixed into
 * somebody else's browser. Behind plain http (a development hub, the test
 * suite) the prefix is not settable at all, so the bare name is used there.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

/**
 * The operator's browser session, carried entirely by the client.
 *
 * `"<expiresMs>.<HMAC>"` and nothing else — there is no session table, which is
 * what lets the hub stay stateless while still recognising someone who has
 * already typed the password. The value doubles as the handle the consent
 * form's CSRF token is bound to.
 *
 * Shared rather than reimplemented: `hasValidSession` is read outside the auth
 * layer (the upstream OAuth callback in `src/upstream/routes.ts`), so two
 * copies of this format drifting apart would break a flow that neither of them
 * looks like it owns.
 */
export function createSessionCookie(secret: string): string {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires, secret)}`;
}

/**
 * The verified cookie value, or undefined when absent, forged or expired.
 *
 * Only the name for this deployment is read: behind HTTPS the bare name is not
 * the session cookie, whatever it carries.
 */
export function readSessionCookie(cookieHeader: string | undefined, secret: string, secure = false): string | undefined {
  const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${sessionCookieName(secure)}=([^;]+)`));
  if (!match) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const [expires, signature, extra] = value.split('.');
  if (extra !== undefined) return undefined;
  if (!expires || !signature) return undefined;
  if (!signatureMatches(expires, signature, secret)) return undefined;
  return Number(expires) > Date.now() ? value : undefined;
}

export function csrfToken(sessionValue: string, secret: string): string {
  return sign(`csrf:${sessionValue}`, secret);
}

export function verifyCsrfToken(sessionValue: string, token: unknown, secret: string): boolean {
  if (typeof token !== 'string') return false;
  return signatureMatches(`csrf:${sessionValue}`, token, secret);
}
