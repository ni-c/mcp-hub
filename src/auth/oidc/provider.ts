import type { Configuration, KoaContextWithOIDC } from 'oidc-provider';
import Provider, { errors } from 'oidc-provider';

import type { AuthStore } from '../store.js';
import { createOidcAdapter } from './adapter.js';
import { HUB_SCOPE, installThrowawaySecret } from './quirks.js';

/** Pinned by test/e2e.test.ts — a client that caches `expires_in` must not be
 *  handed a different number by the new authorization server. */
const ACCESS_TOKEN_TTL_S = 15 * 60;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 10 * 60;
const SESSION_TTL_S = 30 * 60;

/** The single pseudo-account. The hub authenticates one operator with one
 *  password; there are no user accounts to tell apart. */
export const HUB_ACCOUNT_ID = 'mcp-hub-user';

export interface OidcProviderOptions {
  /** Origin without a path, with the trailing slash mcp-hub compares byte-wise. */
  externalUrl: string;
  /** Same contract as HubOAuthProviderOptions: called per request, because
   *  mcp.json is hot-reloaded and a server can appear or vanish between two
   *  authorizations. */
  resolveResource?: (resource: URL) => URL | undefined;
  /** Refuse an authorization that names no resource at all. */
  requireResource?: boolean;
  /** Bind tokens here when a client sends no resource parameter. */
  defaultResource?: URL;
  /** False drops /register and the registration_endpoint from discovery. */
  allowDynamicRegistration?: boolean;
  /** Where an unauthenticated authorization request is sent to log in. Must NOT
   *  be the authorization path: `${routes.authorization}/:uid` is the resume
   *  route, and pointing the interaction at it makes the flow chase its own
   *  tail. Defaults to /interaction, which is in RESERVED_NAMES. */
  interactionPath?: string;
}

/**
 * The hub's authorization server.
 *
 * Routes are reconfigured onto mcp-hub's existing paths rather than mounted
 * under a prefix: `#mountPath` is derived from the issuer (provider.js), and the
 * hub's issuer is the origin root, so a prefixed mount would publish URLs the
 * router does not answer on. See `mount.ts`.
 */
export function buildOidcProvider(store: AuthStore, options: OidcProviderOptions): Provider {
  const issuer = new URL(options.externalUrl).origin;

  /** Undefined for anything the hub would not serve; the caller turns that into
   *  `invalid_target` rather than minting an unusable token. */
  const resolve = (indicator: string): URL | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(indicator);
    } catch {
      return undefined;
    }
    return options.resolveResource ? options.resolveResource(parsed) : parsed;
  };

  const configuration: Configuration = {
    adapter: createOidcAdapter(store),

    // mcp-hub's paths, not oidc-provider's defaults. Every one of these is
    // already in RESERVED_NAMES, so no MCP server can collide with them.
    routes: {
      authorization: '/authorize',
      token: '/token',
      revocation: '/revoke',
      registration: '/register',
      jwks: '/jwks',
      end_session: '/session/end',
      userinfo: '/userinfo'
    },

    // --- OAuth 2.1, no OIDC ------------------------------------------------
    // `openid` cannot be removed from scopes_supported and the id_token alg
    // list cannot be removed from the discovery document — configuration.js
    // adds the first unconditionally and discovery.js the second. Documented
    // rather than fought: nothing is issued for either.
    responseTypes: ['code'],
    scopes: [],
    claims: {},

    features: {
      registration: { enabled: options.allowDynamicRegistration !== false },
      registrationManagement: { enabled: options.allowDynamicRegistration !== false, rotateRegistrationAccessToken: false },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      // Ships hardcoded /interaction/:uid routes that accept ANY password.
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        useGrantedResource: () => true,
        /** Mirrors the resource server: a client that sends none still gets a
         *  bound token, unless the operator demanded an explicit one. */
        defaultResource: () => (options.requireResource ? undefined : options.defaultResource?.href),
        getResourceServerInfo: (_ctx, resourceIndicator) => {
          // Same canonicalisation the resource server applies (/hub/mcp -> /hub,
          // /<name> -> /<name>/mcp). Minting a token for an audience the hub
          // would not accept produces a 401 the client cannot act on.
          const canonical = resolve(resourceIndicator);
          if (!canonical) throw new errors.InvalidTarget('unknown resource');
          return {
            audience: canonical.href,
            accessTokenTTL: ACCESS_TOKEN_TTL_S,
            scope: HUB_SCOPE
            // No `accessTokenFormat` -> opaque. Deliberate: oidc-provider never
            // persists a JWT access token (formats/jwt.js returns no payload),
            // so with JWTs `revokedBefore` could only be an expiry window.
            // Opaque tokens go through the adapter, where revocation is immediate.
          };
        }
      }
    },

    // --- Quirk 3: refresh tokens without offline_access ---------------------
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    // Not optional alongside the above: the default marks every code issued
    // without `offline_access` as session-bound, and a session-bound token
    // stops resolving once the browser session is gone. The hub's clients are
    // headless.
    expiresWithSession: async () => false,

    // Forces refresh_token into grant_types for clients that sent their own
    // list. Runs between #assign and #initialize, must be synchronous, and
    // needs at least one declared property or it is never called.
    extraClientMetadata: {
      properties: ['x_mcp_hub'],
      validator(_ctx, key, _value, metadata) {
        if (key !== 'x_mcp_hub') return;
        const grants = (metadata.grant_types as string[] | undefined) ?? ['authorization_code'];
        if (!grants.includes('refresh_token')) metadata.grant_types = [...grants, 'refresh_token'];
      }
    },

    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      // Not cosmetic: the hub's key is Ed25519, so RS256 — which is what
      // oidc-provider defaults a new client to — is not an algorithm this
      // server has a key for, and every registration is refused with
      // "id_token_signed_response_alg must be 'EdDSA' or 'Ed25519'". No
      // id_token is ever issued; the client still has to declare an algorithm
      // the server could sign one with.
      id_token_signed_response_alg: 'EdDSA'
    },

    /**
     * The hub approves a CLIENT, not a set of scopes, so the grant is minted
     * here rather than assembled from a consent screen's checkboxes. This is
     * also what makes an already-approved client skip consent, which is what
     * AuthStore.getApproval() records.
     */
    loadExistingGrant: async (ctx: KoaContextWithOIDC) => {
      const clientId = ctx.oidc.client?.clientId;
      if (!clientId) return undefined;
      const existing = ctx.oidc.result?.consent?.grantId ?? ctx.oidc.session?.grantIdFor(clientId);
      if (existing) return ctx.oidc.provider.Grant.find(existing);

      const grant = new ctx.oidc.provider.Grant({ clientId, accountId: ctx.oidc.session?.accountId });
      const requested = ctx.oidc.params?.resource;
      for (const resource of [requested ?? []].flat()) {
        grant.addResourceScope(String(resource), HUB_SCOPE);
      }
      await grant.save();
      return grant;
    },

    findAccount: (_ctx, sub) => ({ accountId: sub, claims: async () => ({ sub }) }),

    interactions: {
      url: (_ctx, interaction) => `${options.interactionPath ?? '/interaction'}/${interaction.uid}`
    },

    // The hub's own signing key. Supplying it keeps oidc-provider from falling
    // back to the development keys it warns about; with opaque access tokens
    // nothing user-facing is signed with it.
    jwks: { keys: [store.privateKey.export({ format: 'jwk' }) as Record<string, unknown>] },

    cookies: { keys: [store.cookieSecret] },

    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_S,
      RefreshToken: REFRESH_TOKEN_TTL_S,
      AuthorizationCode: CODE_TTL_S,
      Session: SESSION_TTL_S,
      Interaction: CODE_TTL_S,
      Grant: REFRESH_TOKEN_TTL_S
    },

    // Not yet reached: CIMD and private_key_jwt are the only features that make
    // oidc-provider fetch anything, and both stay off until the hub's pinned,
    // DNS-rebinding-safe client is wired into `configuration.fetch`. The caps
    // are set now because the defaults for two of the three are Infinity, and
    // an unbounded fetch is not something to discover later.
    fetchResponseBodyLimits: {
      'client_id metadata document': 5 * 1024,
      jwks_uri: 64 * 1024,
      sector_identifier_uri: 8 * 1024
    }
  };

  const provider = new Provider(issuer, configuration);
  installThrowawaySecret(provider);
  return provider;
}
