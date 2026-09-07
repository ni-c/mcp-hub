import { afterEach, describe, expect, it } from 'vitest';

import { authorizeInBrowser, registerPublicClient } from '../../test/auth-flow.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { tierEnabled } from '../harness/tiers.js';
import { REDIRECT_URI } from '../harness/token.js';

/**
 * What a hub does when nobody gave it a password.
 *
 * It starts — `/livez`, the discovery documents and every read-only surface
 * keep working, which is what a health check or a directory crawler needs —
 * and it says in its first log lines that the login is disabled. Nobody can
 * sign in, so no client is ever approved and no token is ever minted.
 *
 * Until 0.11.2 the second half was the other way round: the comparison in
 * `checkPassword` reduced to two empty buffers, which match, so an empty form
 * field approved the client. This suite is the decision, written down.
 */

let gateway: Gateway | undefined;

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe.runIf(tierEnabled('process'))('a hub with no PASSWORD and no PASSWORD_HASH', () => {
  it('starts, and says on its first lines that the login is disabled', async () => {
    gateway = await startGateway({
      prefix: 'no-password',
      servers: {},
      // The empty string is what an unset variable becomes here: `hubEnvironment`
      // spreads `env` last, and the hub's own `process.env.PASSWORD` is falsy
      // either way, so this is the same state as never setting it.
      env: { PASSWORD: '' }
    });
    expect(gateway.stderr()).toMatch(/neither PASSWORD_HASH nor PASSWORD is set — the operator login is disabled/);
  });

  it('refuses an empty password at the operator login', async () => {
    gateway = await startGateway({ prefix: 'no-password-login', servers: {}, env: { PASSWORD: '' } });
    const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
    // The login page answers 503 with the reason and never redirects on, so the
    // walk stalls there instead of arriving at the redirect URI with a code.
    await expect(
      authorizeInBrowser(gateway.target, clientId, { password: '', redirectUri: REDIRECT_URI, resource: `${gateway.externalUrl}/hub` })
    ).rejects.toThrow(/stalled at hop \d+ on \/interaction\/[^ ]+ 503/);
  });
});
