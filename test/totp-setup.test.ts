import { describe, expect, it } from 'vitest';

import { parseTotpSecret } from '../src/auth/totp.js';
import { prepareTotpSetup, totpAccountLabel } from '../src/auth/totp-setup.js';

describe('prepareTotpSetup', () => {
  it('makes a fresh 160-bit secret that the hub accepts', () => {
    const setup = prepareTotpSetup('hub.example.com');
    expect(parseTotpSecret(setup.secret).key?.length).toBe(20);
    expect(prepareTotpSetup('hub.example.com').secret).not.toBe(setup.secret);
  });

  it('offers the secret in groups of four, the URIs and a QR code of the otpauth URI', () => {
    const setup = prepareTotpSetup('hub.example.com', { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
    expect(setup.setupKey).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(setup.uri).toBe('otpauth://totp/mcp-hub:hub.example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=mcp-hub&algorithm=SHA1&digits=6&period=30');
    expect(setup.appleUri).toBe(setup.uri.replace('otpauth:', 'apple-otpauth:'));
    const rows = setup.qr.split('\n');
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map(row => [...row].length)).size).toBe(1);
    expect(setup.qr).toMatch(/^[█▀▄ \n]+$/);
  });

  it('can draw the QR code for a light terminal instead', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const dark = prepareTotpSetup('hub', { secret }).qr;
    const light = prepareTotpSetup('hub', { secret, lightTerminal: true }).qr;
    expect(light).not.toBe(dark);
    expect([...light].filter(c => c === '█').length).not.toBe([...dark].filter(c => c === '█').length);
  });
});

describe('totpAccountLabel', () => {
  it.each([
    [undefined, 'mcp-hub'],
    ['', 'mcp-hub'],
    ['not a url', 'mcp-hub'],
    ['https://hub.example.com', 'hub.example.com'],
    ['https://hub.example.com:8443/', 'hub.example.com:8443']
  ])('labels %j as %s', (externalUrl, label) => {
    expect(totpAccountLabel(externalUrl)).toBe(label);
  });
});
