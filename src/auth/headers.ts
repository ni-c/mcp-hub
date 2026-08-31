import type { RequestHandler, Response } from 'express';

/**
 * Browser hardening for the two interactive pages. `form-action` is the
 * delicate one: the login and consent forms post back to the hub, but a
 * successful submission ends in a redirect to the client's redirect_uri, and
 * browsers apply `form-action` to every hop of that chain — not just the
 * first. A bare `'self'` therefore blocks the last hop, and the window simply
 * sits there with no visible error, so the pages have to name the one origin
 * their flow legitimately ends on.
 */
function contentSecurityPolicy(formActionOrigins: readonly string[] = []): string {
  const formAction = ["'self'", ...formActionOrigins].join(' ');
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

/**
 * Widen `form-action` to the origin of a redirect_uri that has already been
 * checked against the client's registration — never to anything a request
 * carried in unvalidated.
 */
export function allowFormActionTo(res: Response, redirectUri: string): void {
  let origin: string;
  try {
    origin = new URL(redirectUri).origin;
  } catch {
    return; // an unparseable URI never gets this far; keep the strict header regardless
  }
  // Opaque origins ('null') would widen the directive to every sandboxed
  // document, and same-origin redirects are covered by 'self' already.
  if (origin === 'null') return;
  res.set('Content-Security-Policy', contentSecurityPolicy([origin]));
}

/**
 * The headers every page and token response of the auth surface carries.
 *
 * Shared rather than repeated: the mounted authorization server is a Koa app
 * the Express router never enters, so these have to be put in front of it
 * explicitly -- and two copies of the list would drift the moment one of them
 * gained a header.
 *
 * RFC 6749 §5.1 requires `no-store` on token responses; the login form has no
 * business being cached either. The CSP and the legacy frame header keep an
 * attacker from clickjacking approval or password entry. This application has
 * no legitimate framing use case.
 */
export const authSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', contentSecurityPolicy());
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
};
