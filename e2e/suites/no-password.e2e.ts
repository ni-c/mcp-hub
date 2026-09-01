import { afterEach, describe, expect, it } from 'vitest';

import { authorizeInBrowser, registerPublicClient } from '../../test/auth-flow.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { tierEnabled } from '../harness/tiers.js';
import { REDIRECT_URI } from '../harness/token.js';

/**
 * What a hub does when nobody gave it a password.
 *
 * `EXTERNAL_URL` is checked at boot by `requireEnv` and the process exits
 * without one. `PASSWORD` and `PASSWORD_HASH` are not checked anywhere: with
 * neither set the hub starts, logs nothing about it, and serves. The comparison
 * in `checkPassword` then reduces to comparing two empty buffers, which is a
 * match — so the operator login is open to anyone who can reach the port.
 *
 * That is worth a test whichever way it is resolved. If the hub is meant to
 * refuse to start, this file says what "refuse" looks like. If it is meant to
 * start, the second test is the one that has to change, and changing it is a
 * decision somebody makes on purpose rather than a default nobody chose.
 */

let gateway: Gateway | undefined;

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe.runIf(tierEnabled('process'))('a hub with no PASSWORD and no PASSWORD_HASH', () => {
  it('starts, and says nothing about it', async () => {
    gateway = await startGateway({
      prefix: 'no-password',
      servers: {},
      // The empty string is what an unset variable becomes here: `hubEnvironment`
      // spreads `env` last, and the hub's own `process.env.PASSWORD` is falsy
      // either way, so this is the same state as never setting it.
      env: { PASSWORD: '' }
    });
    expect(gateway.stderr()).not.toMatch(/password/i);
  });

  it('lets an empty password through the operator login', async () => {
    gateway = await startGateway({ prefix: 'no-password-login', servers: {}, env: { PASSWORD: '' } });
    const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
    const { code } = await authorizeInBrowser(gateway.target, clientId, {
      password: '',
      redirectUri: REDIRECT_URI,
      resource: `${gateway.externalUrl}/hub`
    });

    // Anybody who can reach the port can mint themselves a token for every
    // server the hub fronts. Recorded as the behaviour it is, so that changing
    // it is a deliberate act with a failing test attached.
    expect(code).toBeTruthy();
  });
});
