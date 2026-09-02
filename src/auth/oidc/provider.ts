import type { Configuration, KoaContextWithOIDC } from 'oidc-provider';
import Provider, { errors } from 'oidc-provider';

import type { CimdResolver } from '../cimd.js';
import { isSafeRedirectUri, redirectUriMatches } from '../redirect-uri.js';
import { clampDisplayName } from '../text.js';
import type { AuthStore } from '../store.js';
import { createOidcAdapter } from './adapter.js';
import { HUB_SCOPE, installDiscoveryFixups, installThrowawaySecret } from './quirks.js';

/**
 * The grant types this server has. `clientDefaults` below and the discovery
 * document say the same thing; this is the list a client's own declaration is
 * trimmed against, so it lives where both can be checked against it.
 */
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

/** Pinned by test/e2e.test.ts — a client that caches `expires_in` must not be
 *  handed a different number by the new authorization server. */
const ACCESS_TOKEN_TTL_S = 15 * 60;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 10 * 60;
const SESSION_TTL_S = 30 * 60;
/** RFC 7523 §3 recommends a short window; the hub has always required five
 *  minutes, and a captured assertion is only useful inside it. */
const MAX_ASSERTION_LIFETIME_S = 5 * 60;

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
  /** Resolves https client_ids into clients. Absent turns CIMD off entirely. */
  cimd?: CimdResolver;
  /** Where an unauthenticated authorization request is sent to log in. Must NOT
   *  be the authorization path: `${routes.authorization}/:uid` is the resume
   *  route, and pointing the interaction at it makes the flow chase its own
   *  tail. Defaults to /interaction, which is in RESERVED_NAMES.
   *
   *  The URL gets a TRAILING SLASH: interactions.js scopes the interaction
   *  cookie to the destination path, so the form handlers have to live beneath
   *  it, and a relative `action="login"` only resolves that way from a path
   *  that ends in a slash. */
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
  // NOT `.origin`. The hub publishes EXTERNAL_URL in `URL.href` form -- with a
  // trailing slash -- in `iss`, `aud`, the AS metadata issuer and the PRM
  // document, because claude.ai compares them byte for byte. oidc-provider
  // accepts it: `mountPath` becomes '/' and pathFor() still yields '/token'.
  const issuer = new URL(options.externalUrl).href;

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
    adapter: createOidcAdapter(store, options.cimd),

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
      // Enabled so a registration_access_token and registration_client_uri are
      // issued at all -- but the hub serves GET/PUT/DELETE itself, mounted
      // ahead of this. oidc-provider's version does not withdraw an approval
      // when the redirect URIs move, does not hold an update to the same
      // redirect-URI policy as the registration, and does not clamp a client
      // name that arrives with newlines in it.
      registrationManagement: { enabled: options.allowDynamicRegistration !== false, rotateRegistrationAccessToken: false },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      // Ships hardcoded /interaction/:uid routes that accept ANY password.
      devInteractions: { enabled: false },

      // Both are on by default and both would be ADVERTISED in the discovery
      // document while their endpoints are not mounted -- a client that
      // believed the document would get a 404. Neither is wanted: the hub has
      // no browser session to end, and PAR solves a problem it does not have.
      pushedAuthorizationRequests: { enabled: false },
      rpInitiatedLogout: { enabled: false },

      /**
       * Enabled for what it advertises and for the client_id URL check — NOT
       * for its fetcher. The adapter resolves metadata documents through the
       * hub's own CimdResolver, which models/client.js consults first, and
       * `allowFetch` refuses so the built-in path can never run.
       *
       * That is a deliberate choice, not an accident of ordering. The library
       * caps the body at 5 KiB, times out at 2.5 s and refuses redirects; it
       * does NOT pin the resolved address against DNS rebinding, enforce an
       * origin allowlist, or rate-limit per origin. The hub does all three.
       */
      clientIdMetadataDocument: {
        enabled: options.cimd !== undefined,
        ack: 'draft-02',
        allowFetch: () => false
      },
      resourceIndicators: {
        enabled: true,
        useGrantedResource: () => true,
        /**
         * Real clients omit the RFC 8707 parameter (older Codex logins, Google
         * ADK, Gemini Enterprise), so "none requested" has to mean something.
         *
         *   - DEFAULT_RESOURCE, when the operator set one: the token is still
         *     bound, just not by the client's choosing.
         *   - the issuer itself in unbound mode, which is the pre-0.5 migration
         *     behaviour the hand-written server had — one token reaches every
         *     route, and the per-route check is what narrows it.
         *   - a refusal when binding is required, matching the old
         *     `invalid_target` rather than letting the flow die later as
         *     `access_denied`, which says nothing the client can act on.
         */
        defaultResource: () => {
          if (options.defaultResource) return options.defaultResource.href;
          if (!options.requireResource) return options.externalUrl;
          throw new errors.InvalidTarget('A resource indicator is required');
        },
        getResourceServerInfo: (_ctx, resourceIndicator) => {
          // The issuer itself is the unbound audience; it is not an MCP route,
          // so the canonicaliser would refuse it.
          if (resourceIndicator === options.externalUrl) {
            return { audience: resourceIndicator, accessTokenTTL: ACCESS_TOKEN_TTL_S, scope: HUB_SCOPE };
          }
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

    /**
     * Exactly the three the hub advertised before, and no more. Dropping
     * `client_secret_basic` and `client_secret_jwt` from oidc-provider's
     * defaults is a deliberate narrowing: nothing the hub issues can use them,
     * and an authentication mechanism nobody uses is only an attack surface.
     */
    clientAuthMethods: ['client_secret_post', 'none', 'private_key_jwt'],

    // The set the hub advertised before. oidc-provider's default is narrower
    // (one algorithm per family), which would refuse a private_key_jwt client
    // that signs with RS384 -- something the old document promised to accept.
    enabledJWA: {
      clientAuthSigningAlgValues: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']
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
        /**
         * Two adjustments, and the second one is why claude.ai could not
         * connect to 0.11.0 at all.
         *
         * A client may declare grant types this server does not offer, and
         * oidc-provider refuses the whole registration when it sees one —
         * `invalid_client_metadata: grant_types can only contain
         * 'authorization_code' or 'refresh_token'`. claude.ai's metadata
         * document declares `urn:ietf:params:oauth:grant-type:jwt-bearer`
         * alongside the two it actually uses here, so every attempt died on a
         * grant it was never going to ask for. The hand-written server this
         * replaced ignored the extras, which is why the failure arrived with
         * the rewrite rather than with the client.
         *
         * Dropping them is the right answer rather than a lenient one: what a
         * client may do is decided by what the authorization server supports,
         * the registration response says which types were actually registered
         * (RFC 7591 §3.2.1), and a client reading that response learns the
         * truth. Rejecting instead makes an optimistic superset — the sensible
         * thing for a client that talks to many servers — fatal.
         */
        const declared = (metadata.grant_types as string[] | undefined) ?? ['authorization_code'];
        const grants = declared.filter(grant => SUPPORTED_GRANT_TYPES.includes(grant));
        // Everything it asked for is something this server has never heard of.
        // That is not a superset to trim, it is a client aimed at the wrong
        // kind of server, and saying so beats registering it with no way to
        // get a token.
        if (grants.length === 0) {
          throw new errors.InvalidClientMetadata(
            `grant_types must include one of: ${SUPPORTED_GRANT_TYPES.join(', ')}`
          );
        }
        if (!grants.includes('refresh_token')) grants.push('refresh_token');
        metadata.grant_types = grants;

        /**
         * The hub's redirect-URI policy, which oidc-provider does not have:
         * it keeps out javascript:/data:/vbscript: but accepts plain http to
         * any host. That last one matters — the authorization code travels in
         * the clear on the final redirect, and a public client has nothing
         * else to prove itself with.
         *
         * A metadata-document client is held to the stricter half: the MCP
         * specification allows it only https or loopback, never a private-use
         * scheme.
         */
        /**
         * A client name goes straight onto the consent page and into the log.
         * The hub clamps it -- newlines out, length capped -- and oidc-provider
         * does not, so an application could otherwise choose a "name" that took
         * over the page it is being approved on.
         */
        if (metadata.client_name !== undefined) {
          metadata.client_name = clampDisplayName(metadata.client_name);
        }

        // A private-use scheme (com.example.app:/cb) is only valid for a native
        // client as far as oidc-provider is concerned, and native is what such
        // a client actually is. Without this the registration is refused and
        // RFC 8252 clients have no way in.
        const uris = (metadata.redirect_uris as string[] | undefined) ?? [];
        if (uris.some(uri => !/^https?:/i.test(uri))) metadata.application_type = 'native';

        const allowPrivateUseSchemes = !String(metadata.client_id ?? '').startsWith('https://');
        for (const uri of uris) {
          if (!isSafeRedirectUri(uri, { allowPrivateUseSchemes })) {
            throw new errors.InvalidClientMetadata('redirect_uris must be https, loopback http, or a private-use scheme');
          }
        }
      }
    },

    clientDefaults: {
      grant_types: [...SUPPORTED_GRANT_TYPES],
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
      /**
       * The approval is checked FIRST, before any grant already attached to the
       * session, because approval is per redirect TARGET and not per client.
       * Returning the session's existing grant straight away would mean that
       * approving a client for `http://localhost:1234/callback` silently
       * approved it for `/other` as well — a code sent somewhere the user never
       * agreed to.
       *
       * Minting only for an approved client is also what keeps the consent page
       * reachable at all: approving unconditionally would satisfy the prompt
       * every time, and the page that asks "did you start this?" would never be
       * shown again.
       */
      const redirectUri = String(ctx.oidc.params?.redirect_uri ?? '');
      const approval = store.getApproval(clientId);
      const approved = approval?.redirectUris.some(uri => redirectUriMatches(redirectUri, uri)) ?? false;
      if (!approved && !ctx.oidc.result?.consent) return undefined;

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

    /**
     * Caps how long a client assertion may live.
     *
     * oidc-provider only checks that it has not expired, so a client could sign
     * one valid for a year and anything that captured it would hold a
     * reusable credential for that long. The hub has always required five
     * minutes, which is what RFC 7523 §3 recommends and what keeps a leaked
     * assertion close to worthless.
     */
    assertJwtClientAuthClaimsAndHeader: async (_ctx, claims) => {
      const lifetime = Number(claims.exp) - Number(claims.iat ?? claims.exp);
      if (!Number.isFinite(lifetime) || lifetime > MAX_ASSERTION_LIFETIME_S) {
        throw new errors.InvalidClientAuth('assertion is valid for too long');
      }
    },

    /**
     * JSON, not the library's HTML page.
     *
     * This is reached when an authorization request cannot be redirected back
     * -- an unknown client, a redirect_uri that does not match -- which is
     * precisely when the caller is a program rather than a person. The hub has
     * always answered those with a machine-readable body, and a connector that
     * gets HTML has nothing to log but a wall of markup.
     */
    renderError: (ctx, out) => {
      ctx.type = 'json';
      ctx.body = out;
    },

    interactions: {
      url: (_ctx, interaction) => `${options.interactionPath ?? '/interaction'}/${interaction.uid}/`
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

    /**
     * Every outbound request oidc-provider makes goes through the hub's pinned
     * client. With the metadata-document path closed above, that leaves
     * `jwks_uri` for private_key_jwt clients — and that one needs it most:
     * unlike its own CIMD fetch, oidc-provider requests jwks_uri with neither
     * `redirect: 'manual'` nor a body cap (the default limit is Infinity).
     * `safeFetch` refuses non-https, pins the resolved public address so a
     * second DNS answer cannot redirect it inward, and caps the body.
     */
    ...(options.cimd ? { fetch: options.cimd.safeFetch as Configuration['fetch'] } : {}),

    // Defence in depth behind `safeFetch`: two of the three defaults are
    // Infinity, and an unbounded fetch is not something to discover later.
    fetchResponseBodyLimits: {
      'client_id metadata document': 5 * 1024,
      jwks_uri: 64 * 1024,
      sector_identifier_uri: 8 * 1024
    }
  };

  const provider = new Provider(issuer, configuration);

  /**
   * RFC 8252 §7.3: a native client listens on an ephemeral loopback port and
   * cannot know it in advance, so `http://127.0.0.1:1234/cb` and
   * `http://127.0.0.1:51234/cb` are the same redirect target. oidc-provider
   * compares exactly and would refuse every run after the first.
   *
   * Uses the same matcher the approval check does, so "approved for this
   * target" and "allowed to redirect there" cannot drift apart.
   */
  const exactlyAllowed = provider.Client.prototype.redirectUriAllowed;
  provider.Client.prototype.redirectUriAllowed = function redirectUriAllowed(this: { redirectUris: string[] }, value: string) {
    if (exactlyAllowed.call(this, value)) return true;
    return (this.redirectUris ?? []).some(uri => redirectUriMatches(value, uri));
  };

  installThrowawaySecret(provider, store);
  installDiscoveryFixups(provider);
  return provider;
}
