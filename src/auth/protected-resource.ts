import { Router } from 'express';

import { authSecurityHeaders } from './headers.js';

export interface ProtectedResourceOptions {
  /** `URL.href` form, byte-identical to the AS metadata issuer. */
  externalUrl: string;
  resourceName?: string;
}

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * This is the RESOURCE SERVER's document, not the authorization server's, which
 * is why it lives outside `createAuthRoutes` and survives whichever
 * authorization server the hub is running. Losing it would take out discovery
 * for every client, and it is the one piece of the auth surface that is not
 * oidc-provider's to serve.
 *
 * Two shapes, both required: the root document the SDK used to publish, and the
 * path-scoped form (§3.1) a client connected to `/<name>/mcp` looks up first.
 */
export function createProtectedResourceRoutes(options: ProtectedResourceOptions): Router {
  const router = Router();
  const issuerUrl = new URL(options.externalUrl);
  const resourceName = options.resourceName ?? 'mcp-hub';

  // These used to be served from inside the auth router and inherited its
  // headers; pulled out here, they would have quietly lost them. A discovery
  // document is exactly the thing a shared cache should not keep.
  router.use(authSecurityHeaders);

  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: issuerUrl.href,
      authorization_servers: [options.externalUrl],
      resource_name: resourceName
    });
  });

  router.get('/.well-known/oauth-protected-resource/{*splat}', (req, res) => {
    const suffix = req.path.replace('/.well-known/oauth-protected-resource', '');
    res.json({
      resource: issuerUrl.origin + suffix,
      authorization_servers: [options.externalUrl],
      bearer_methods_supported: ['header'],
      resource_name: resourceName
    });
  });

  return router;
}
