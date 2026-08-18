import type { Response } from 'express';

/**
 * Browser hardening for the two interactive pages. `form-action` is the
 * delicate one: the login and consent forms post back to the hub, but a
 * successful submission ends in a redirect to the client's redirect_uri, and
 * browsers apply `form-action` to every hop of that chain — not just the
 * first. A bare `'self'` therefore blocks the last hop, and the window simply
 * sits there with no visible error, so the pages have to name the one origin
 * their flow legitimately ends on.
 */
export function contentSecurityPolicy(formActionOrigins: readonly string[] = []): string {
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
