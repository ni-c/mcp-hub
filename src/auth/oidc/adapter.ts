import { errors } from 'oidc-provider';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';

import { type CimdResolver, isClientIdMetadataUrl } from '../cimd.js';
import type { AuthStore } from '../store.js';

/**
 * oidc-provider's ten models, all backed by the one `AuthStore` the hub already
 * serialises every other write through.
 *
 * The store is not replaced by this and does not shrink: API tokens, upstream
 * credentials and the cross-process lock the admin CLI shares are mcp-hub's own
 * concepts and have nothing to do with the authorization server. What this adds
 * is a flat artifact slot the library owns the shape of.
 *
 * Two behaviours are deliberately in the store rather than here:
 *
 *   - the `revokedBefore` cutoff, because `find()` returning falsy IS the
 *     revocation as far as the library is concerned (base_model.js treats any
 *     falsy return as "not found"), and
 *   - `consumed`, because a consumed authorization code has to be
 *     distinguishable from an unknown one or replay detection cannot work.
 */
export function createOidcAdapter(store: AuthStore, cimd?: CimdResolver): AdapterFactory {
  return (model: string): Adapter => (model === 'Client' ? clientAdapter(store, cimd) : artifactAdapter(store, model));
}

/**
 * Clients are NOT stored in the generic artifact slot.
 *
 * `mcp-hub-admin clients list|prune|revoke`, the ceiling on unapproved clients,
 * the activity stamps behind ageing registrations out, and the approval records
 * all read `state.clients`. Putting oidc-provider's clients anywhere else would
 * leave the admin CLI looking at an empty hub while the authorization server
 * happily served a full one — two stores, one truth, no error message.
 *
 * The shapes already agree: both are RFC 7591 metadata keyed by `client_id`.
 */
function clientAdapter(store: AuthStore, cimd?: CimdResolver): Adapter {
  return {
    async upsert(id: string, payload: AdapterPayload): Promise<void> {
      const record = { ...(payload as Record<string, unknown>), client_id: id } as never;
      // A NEW client goes through addClient, which is what enforces the ceiling
      // on unapproved registrations and creates the lifecycle entry the
      // activity stamps and `mcp-hub-admin clients prune` are built on. Writing
      // it with saveClient would leave a client nothing ages out.
      if (store.getClient(id)) {
        store.updateClient(record);
        return;
      }
      // False means the hub is full of clients that were all confirmed, and
      // dropping one of those would take a connector somebody uses offline.
      // Refusing the newcomer is the failure an operator can see and fix, so it
      // has to surface rather than be swallowed into a successful-looking
      // registration that stored nothing.
      if (!store.addClient(record)) {
        const full = new errors.OIDCProviderError(400, 'too_many_requests');
        full.error_description = 'the hub is not accepting new client registrations right now';
        throw full;
      }
    },

    /**
     * Client ID Metadata Documents are resolved HERE, deliberately.
     *
     * models/client.js consults the adapter BEFORE its own metadata-document
     * fetcher, so returning the document from here means oidc-provider's
     * fetcher is never reached — and the hub keeps a materially stricter
     * policy than the library's: DNS pinning against rebinding, an origin
     * allowlist, per-origin failure counting so distinct client_ids on one host
     * cannot be used to hammer it, and negative caching. oidc-provider has none
     * of those. `allowFetch` is wired to refuse, so the built-in path stays
     * closed even if this returns nothing.
     *
     * Nothing is written: a CIMD client is not registered, which is the point
     * of it — the client reinstalls and is still the same client.
     */
    async find(id: string): Promise<AdapterPayload | undefined> {
      const registered = store.getClient(id);
      if (registered) return registered as AdapterPayload;
      if (cimd && isClientIdMetadataUrl(id)) {
        return (await cimd.resolve(id)) as AdapterPayload | undefined;
      }
      return undefined;
    },
    async findByUid(): Promise<undefined> {
      return undefined;
    },
    async findByUserCode(): Promise<undefined> {
      return undefined;
    },
    async consume(): Promise<void> {
      // Clients are not single-use.
    },
    async destroy(id: string): Promise<void> {
      store.deleteClient(id);
    },
    async revokeByGrantId(): Promise<void> {
      // A grant belongs to a client; revoking it never deletes the client.
    }
  };
}

function artifactAdapter(store: AuthStore, model: string): Adapter {
  return {
    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      store.oidcUpsert(model, id, payload as Record<string, unknown>, expiresIn);
    },

    async find(id: string): Promise<AdapterPayload | undefined> {
      return store.oidcFind(model, id) as AdapterPayload | undefined;
    },

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return store.oidcFindBy(model, 'uid', uid) as AdapterPayload | undefined;
    },

    /**
     * Device flow only, and the hub does not enable it. Returning undefined is
     * the honest answer for a model that is never written; throwing would turn
     * a disabled feature into a 500 if it were ever reached.
     */
    async findByUserCode(): Promise<undefined> {
      return undefined;
    },

    async consume(id: string): Promise<void> {
      store.oidcConsume(model, id);
    },

    async destroy(id: string): Promise<void> {
      store.oidcDestroy(model, id);
    },

    /**
     * Crosses model boundaries by design: revoking a grant has to take the
     * access tokens, refresh tokens and codes minted under it with it, and the
     * library calls this on exactly one of the models.
     */
    async revokeByGrantId(grantId: string): Promise<void> {
      store.oidcRevokeByGrantId(grantId);
    }
  };
}
