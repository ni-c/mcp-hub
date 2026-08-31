import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/core';
import type { AuthStore } from './store.js';
import { isSafeRedirectUri } from './redirect-uri.js';
import { earlyRateLimit } from './rate-limit.js';
import { clampDisplayName, logSafe } from './text.js';

/**
 * RFC 7592, the management half of dynamic client registration: a client that
 * registered itself can read, change and — the point of the exercise — delete
 * its own registration, without the operator having to do it for them.
 *
 * None of this comes from the SDK. Its registration router accepts `POST` and
 * nothing else (`allowedMethods(['POST'])`), and it knows nothing about
 * `registration_access_token`. These routes therefore have to be mounted ahead
 * of it, or the SDK answers `405` for every verb below.
 *
 * The credential is minted once at registration and only its hash is stored,
 * so it is not recoverable from the state file — losing it means asking the
 * operator to remove the registration.
 */

/** Where the client manages the registration it was just given. */
export function registrationClientUri(externalUrl: string, clientId: string): string {
  return new URL(`register/${encodeURIComponent(clientId)}`, externalUrl).href;
}

export interface RegistrationManagementOptions {
  store: AuthStore;
  /** Issuer identifier, used to build `registration_client_uri`. */
  externalUrl: string;
}

interface RegistrationRequest extends Request {
  registrationClient?: OAuthClientInformationFull;
}

/** The body limit is far above any real client metadata document and well
 *  below anything that would matter to the process. */
const MAX_METADATA_BYTES = '64kb';

export function createRegistrationManagementRoutes(options: RegistrationManagementOptions): Router {
  const { store, externalUrl } = options;
  const router = Router();
  const path = '/register/:clientId';
  // Its own budget rather than the 20-per-hour one guarding POST /register.
  // These are authenticated and cheap, and a client that reads and updates its
  // registration should not thereby lose the ability to register again.
  const limit = earlyRateLimit(15 * 60_000, 60, 600);

  const present = (client: OAuthClientInformationFull): Record<string, unknown> => ({
    ...client,
    registration_client_uri: registrationClientUri(externalUrl, client.client_id)
  });

  // The SDK gives POST /register an open CORS policy so browser-based clients
  // can register; these routes sit in front of it and need their own. Opening
  // them is safe: the credential is a bearer token in a header, never a cookie,
  // so no browser attaches it to a cross-site request on its own.
  const allowCrossOrigin = (res: Response): void => {
    res.set('Access-Control-Allow-Origin', '*');
  };

  router.options(path, limit, (_req, res) => {
    allowCrossOrigin(res);
    res.set({
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600'
    });
    res.status(204).end();
  });

  /**
   * Authenticates before anything else runs — the body parser included, so an
   * unauthenticated caller never gets to hand us a document to parse.
   *
   * An unknown client and a wrong token get the same answer. Telling them apart
   * would turn this into a way to find out which client_ids exist.
   */
  const requireRegistrationToken = (req: RegistrationRequest, res: Response, next: NextFunction): void => {
    allowCrossOrigin(res);
    const clientId = String(req.params.clientId);
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const client = token.length > 0 && store.verifyRegistrationToken(clientId, token) ? store.getClient(clientId) : undefined;
    if (!client) {
      console.warn(`mcp-hub: refused registration management for ${logSafe(clientId)}`);
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.status(401).json({ error: 'invalid_token', error_description: 'Invalid registration access token' });
      return;
    }
    req.registrationClient = client;
    next();
  };

  router.get(path, limit, requireRegistrationToken, (req: RegistrationRequest, res) => {
    res.json(present(req.registrationClient!));
  });

  router.put(path, limit, requireRegistrationToken, express.json({ limit: MAX_METADATA_BYTES }), (req: RegistrationRequest, res) => {
    const existing = req.registrationClient!;
    const refuse = (description: string): void => {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: description });
    };
    const body = (req.body ?? {}) as Record<string, unknown>;
    // RFC 7592 §2.2: the client has to say which registration it means, and it
    // may not use this to change its own credentials.
    if (body.client_id !== existing.client_id) {
      refuse('client_id must be present and match the registration being updated');
      return;
    }
    // Only meaningful for a client that actually holds a secret. A public one
    // was handed a throwaway secret in its registration response that was never
    // stored (the accommodation ChatGPT needs), and echoing that back here must
    // not be treated as an attempt to change anything.
    if (existing.client_secret !== undefined && body.client_secret !== undefined && body.client_secret !== existing.client_secret) {
      refuse('client_secret cannot be changed here');
      return;
    }
    const parsed = OAuthClientMetadataSchema.safeParse(body);
    if (!parsed.success) {
      refuse('The submitted client metadata is not valid');
      return;
    }
    const metadata = parsed.data;
    for (const uri of metadata.redirect_uris ?? []) {
      if (!isSafeRedirectUri(uri, { allowPrivateUseSchemes: true })) {
        refuse(`redirect_uri ${uri} must be https, a loopback address or a private-use scheme`);
        return;
      }
    }
    const redirectsChanged = !sameUris(existing.redirect_uris, metadata.redirect_uris);
    const updated = {
      ...metadata,
      client_name: clampDisplayName(metadata.client_name),
      // Identity and credentials are the hub's to assign, not the client's.
      client_id: existing.client_id,
      client_id_issued_at: existing.client_id_issued_at,
      ...(existing.client_secret !== undefined
        ? { client_secret: existing.client_secret, client_secret_expires_at: existing.client_secret_expires_at }
        : {})
    } as OAuthClientInformationFull;
    // Consent was given for a destination. A client that moves the destination
    // afterwards has to be asked again, or the approval would be transferable
    // to somewhere the user never saw.
    store.updateClient(updated, { resetApproval: redirectsChanged });
    if (redirectsChanged) {
      console.log(`mcp-hub: client ${logSafe(existing.client_id)} changed its redirect URIs; its approval was withdrawn`);
    }
    res.json(present(updated));
  });

  router.delete(path, limit, requireRegistrationToken, (req: RegistrationRequest, res) => {
    const clientId = req.registrationClient!.client_id;
    store.deleteClient(clientId);
    console.log(`mcp-hub: client ${logSafe(clientId)} deleted its own registration`);
    res.status(204).end();
  });

  return router;
}

/** Order is not part of the meaning of a redirect URI list. */
function sameUris(before: string[] | undefined, after: string[] | undefined): boolean {
  const a = [...(before ?? [])].sort();
  const b = [...(after ?? [])].sort();
  return a.length === b.length && a.every((uri, index) => uri === b[index]);
}
