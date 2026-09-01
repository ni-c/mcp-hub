import request from 'supertest';

import { authorizeInBrowser, registerPublicClient } from '../../test/auth-flow.js';
import type { Gateway } from './gateway.js';

/**
 * Credentials, obtained the way a client obtains them.
 *
 * Nothing here mints a token behind the hub's back. The OAuth path walks the
 * real browser journey — registration, PKCE, the login form, the consent page —
 * because a token taken from a signing key would prove the hub can verify its
 * own signature and nothing about whether a client can get one. The API-token
 * path shells out to `mcp-hub-admin`, for the same reason.
 *
 * Deliberately assertion-free. The five copies of this in `test/` each check a
 * couple of things inline — that the login page named the resource, that the
 * lifetime is fifteen minutes — and a shared helper that did the same could not
 * be reused by the test that wants the opposite. Those assertions belong to the
 * tests that care.
 */

export const REDIRECT_URI = 'http://localhost:33418/callback';

export interface Token {
  access: string;
  refresh: string;
  clientId: string;
  /** Every page the browser was shown, for assertions about what a user saw. */
  pages: string[];
}

export interface TokenOptions {
  /**
   * The RFC 8707 resource to bind to — a server name, `hub`, or a full URL.
   *
   * Bound tokens are the hub's default since 0.5.0, so a caller that omits this
   * is asking for the migration path and will be refused unless the gateway was
   * started with `RESOURCE_BOUND_TOKENS=false`.
   */
  resource?: string;
  consent?: 'approve' | 'deny';
  scope?: string;
}

/**
 * Turns `hub` or `weather` into the canonical resource URL the hub expects.
 *
 * Built from `externalUrl`, not from `baseUrl`. The hub canonicalises a
 * resource against its own issuer, so at the in-process tier — where the two
 * differ — a resource derived from the port it happened to listen on is
 * rejected as `invalid_target`, which reads like a broken test and is in fact
 * the hub being right.
 */
export function resourceUrl(gateway: Gateway, name: string): string {
  if (name.startsWith('http://') || name.startsWith('https://')) return name;
  const base = gateway.externalUrl.replace(/\/$/, '');
  return name === 'hub' ? `${base}/hub` : `${base}/${name}/mcp`;
}

export async function obtainToken(gateway: Gateway, options: TokenOptions = {}): Promise<Token> {
  const resource = options.resource === undefined ? undefined : resourceUrl(gateway, options.resource);
  const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
  const { code, verifier, pages } = await authorizeInBrowser(gateway.target, clientId, {
    password: gateway.password,
    redirectUri: REDIRECT_URI,
    resource,
    consent: options.consent
  });

  const response = await request(gateway.target as Parameters<typeof request>[0])
    .post('/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      ...(resource ? { resource } : {})
    });
  if (response.status !== 200) {
    throw gateway.explain(new Error(`token exchange failed: ${response.status} ${JSON.stringify(response.body)}`), 'exchanging an authorization code');
  }
  return { access: response.body.access_token, refresh: response.body.refresh_token, clientId, pages };
}

/**
 * A long-lived resource-bound API token, minted by the CLI.
 *
 * The CLI rather than `mintApiToken()` on purpose: this is the credential path
 * for clients that cannot do OAuth at all, and its interesting half is that the
 * minting happens in a *different process* from the hub that has to accept it.
 * Calling the library function in-process would skip precisely the part that
 * once shipped broken.
 */
export async function mintApiToken(gateway: Gateway, resource: string, days = 1): Promise<string> {
  const result = await gateway.admin(['tokens', 'create', '--resource', resource, '--days', String(days), '--label', 'e2e']);
  if (result.code !== 0) {
    throw gateway.explain(new Error(`mcp-hub-admin tokens create failed (${result.code}): ${result.stderr}`), 'minting an API token');
  }
  // The token is the whole of stdout; metadata goes to stderr. `demo/token.sh`
  // relies on exactly that split, so reading it this way keeps the contract
  // under test rather than merely documented.
  const token = result.stdout.trim();
  if (!token) throw new Error(`mcp-hub-admin tokens create printed nothing on stdout. stderr was: ${result.stderr}`);
  return token;
}
