import { sign, signatureMatches } from './signed-token.js';

/** Deliberately short: it only has to outlive a connector's authorization. */
export const SESSION_TTL_MS = 30 * 60_000;
export const SESSION_COOKIE = 'mcp_hub_session';

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

/** The verified cookie value, or undefined when absent, forged or expired. */
export function readSessionCookie(cookieHeader: string | undefined, secret: string): string | undefined {
  const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return undefined;
  const value = decodeURIComponent(match[1]);
  const [expires, signature] = value.split('.');
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
