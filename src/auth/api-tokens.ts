import crypto from 'node:crypto';

import { SignJWT } from 'jose';

import type { AuthStore } from './store.js';

/** Distinguishes admin-minted API tokens from interactive OAuth tokens. */
export const API_TOKEN_SUBJECT = 'mcp-hub-token';

/**
 * Mint a long-lived, resource-bound API token for clients that cannot do
 * OAuth (OpenAI Responses API, xAI API, Gemini API, plain-header clients).
 * The JWT is returned exactly once; only its record (jti) is persisted, which
 * is what `tokens list` shows and `tokens revoke` deletes.
 */
export async function mintApiToken(
  store: AuthStore,
  externalUrl: string,
  resource: URL,
  days: number,
  label: string
): Promise<{ id: string; token: string; expiresAt: number }> {
  const id = crypto.randomBytes(8).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + days * 86_400;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(new URL(externalUrl).href)
    .setAudience(resource.href)
    .setSubject(API_TOKEN_SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setJti(id)
    .sign(store.privateKey);
  store.saveApiToken(id, { label, resource: resource.href, createdAt: now, expiresAt });
  return { id, token, expiresAt };
}
