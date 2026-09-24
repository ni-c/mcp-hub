import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHub } from '../src/index.js';
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { isPrintableAsciiUri, isSafeRedirectUri } from '../src/auth/redirect-uri.js';
import { isClientIdMetadataUrl, validateDocument } from '../src/auth/cimd.js';
import { escapeHtml, renderIdentity } from '../src/auth/page.js';
import { escapeInvisibles } from '../src/auth/text.js';

/**
 * The login and consent pages' one unforgeable anchor — the redirect URI, and
 * the CIMD document URL that vouches for a client's self-declared name — must
 * not be able to visually lie to the operator: an embedded userinfo component
 * would otherwise move the reader's eye onto a hostname the code never
 * actually reaches ("https://claude.ai@attacker.example/cb" resolves to
 * attacker.example), and a bidi override or a zero-width character could
 * reorder or hide whatever the operator reads before approving.
 *
 * Covered here: the shared validators (isSafeRedirectUri, isClientIdMetadataUrl)
 * refuse both classes at every registration entry point that gates a redirect
 * URI or a CIMD client_id — DCR create (POST /register), DCR update (RFC 7592
 * PUT), and CIMD document validation — while every legitimate shape (a real
 * https callback, RFC 8252 loopback on any port, a private-use scheme, an `@`
 * that is legitimately part of a path or query, a percent-encoded byte) keeps
 * being accepted exactly as before; and the rendering layer (escapeInvisibles,
 * wired into renderIdentity) makes the same character class visible rather
 * than invisible, as a second, independent layer that does not depend on the
 * validators above having run.
 */

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const PASSWORD = 'test-password';
const REDIRECT = 'https://app.example.com/cb';
const RLO = String.fromCodePoint(0x202e); // RIGHT-TO-LEFT OVERRIDE
const LRI = String.fromCodePoint(0x2066); // LEFT-TO-RIGHT ISOLATE
const ZWSP = String.fromCodePoint(0x200b); // ZERO WIDTH SPACE
const LS = String.fromCodePoint(0x2028); // LINE SEPARATOR
const PS = String.fromCodePoint(0x2029); // PARAGRAPH SEPARATOR

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-consent-identity-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    idleTimeoutMinutes: 0
  });
  await hub.supervisor.waitUntilSettled();
}, 30_000);

afterAll(async () => {
  hub?.stopMaintenance();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isSafeRedirectUri: userinfo is refused for every accepted scheme', () => {
  it('refuses a username, a username:password, and an empty ":@" userinfo', () => {
    for (const policy of [{ allowPrivateUseSchemes: true }, { allowPrivateUseSchemes: false }]) {
      expect(isSafeRedirectUri('https://claude.ai@attacker.example/cb', policy)).toBe(false);
      expect(isSafeRedirectUri('https://claude.ai:s3cr3t@attacker.example/cb', policy)).toBe(false);
      // The WHATWG parser reports username='' and password='' for this one —
      // the one input `URL#username`/`URL#password` alone cannot catch.
      expect(isSafeRedirectUri('https://:@attacker.example/cb', policy)).toBe(false);
    }
    expect(isSafeRedirectUri('http://user@127.0.0.1:4444/cb', { allowPrivateUseSchemes: true })).toBe(false);
    expect(isSafeRedirectUri('com.example.app://user@host/cb', { allowPrivateUseSchemes: true })).toBe(false);
  });

  it('refuses a userinfo behind an authority spelled with backslashes', () => {
    // No '://' in the raw string, yet the parser reads 'claude.ai' as the user
    // and connects to attacker.example.
    for (const uri of ['https:/\\claude.ai@attacker.example/cb', 'https:\\\\claude.ai@attacker.example/cb']) {
      expect(new URL(uri).protocol, uri).toBe('https:');
      expect(isSafeRedirectUri(uri, { allowPrivateUseSchemes: false }), uri).toBe(false);
    }
  });

  it('does not mistake an "@" in the path, the query, or percent-encoded for userinfo', () => {
    const strict = { allowPrivateUseSchemes: false };
    expect(isSafeRedirectUri('https://app.example.com/cb?x=a@b', strict)).toBe(true);
    expect(isSafeRedirectUri('https://app.example.com/cb%40x', strict)).toBe(true);
    expect(isSafeRedirectUri('https://app.example.com/@handle/cb', strict)).toBe(true);
  });
});

describe('isSafeRedirectUri: printable-ASCII-only', () => {
  it('refuses a bidi override, an isolate, a zero-width space, NUL, TAB and a raw space', () => {
    const policy = { allowPrivateUseSchemes: false };
    for (const evil of [
      `https://app.example.com/cb${RLO}x`,
      `https://app.example.com/cb${LRI}x`,
      `https://app.example.com/cb${ZWSP}x`,
      'https://app.example.com/cb\x00x',
      'https://app.example.com/cb\tx',
      'https://app.example.com/c b'
    ]) {
      expect(isSafeRedirectUri(evil, policy), JSON.stringify(evil)).toBe(false);
    }
  });

  it('refuses DEL (0x7F, one past the accepted range) and accepts "!" and "~" (0x21 and 0x7E, the range\'s own edges)', () => {
    const policy = { allowPrivateUseSchemes: false };
    expect(isSafeRedirectUri('https://app.example.com/cb\x7f', policy)).toBe(false);
    expect(isSafeRedirectUri('https://app.example.com/cb!~', policy)).toBe(true);
  });

  it('still accepts the identical byte percent-encoded', () => {
    expect(isSafeRedirectUri('https://app.example.com/cb%E2%80%AEx', { allowPrivateUseSchemes: false })).toBe(true);
  });

  it('leaves ordinary redirect URIs — real client callbacks, loopback on any port, a private-use scheme — accepted exactly as before', () => {
    expect(isSafeRedirectUri('https://claude.ai/api/mcp/auth_callback', { allowPrivateUseSchemes: false })).toBe(true);
    expect(isSafeRedirectUri('https://chatgpt.com/connector_platform/oauth_redirect', { allowPrivateUseSchemes: false })).toBe(true);
    expect(isSafeRedirectUri('http://127.0.0.1:54891/cb', { allowPrivateUseSchemes: false })).toBe(true);
    expect(isSafeRedirectUri('http://localhost:1/cb', { allowPrivateUseSchemes: false })).toBe(true);
    expect(isSafeRedirectUri('com.example.app:/cb', { allowPrivateUseSchemes: true })).toBe(true);
    // Unchanged: the private-use-scheme policy gate, not this fix.
    expect(isSafeRedirectUri('com.example.app:/cb', { allowPrivateUseSchemes: false })).toBe(false);
    // Unchanged: the dangerous-scheme and remote-http rules, not this fix.
    expect(isSafeRedirectUri('http://app.example.com/cb', { allowPrivateUseSchemes: false })).toBe(false);
    expect(isSafeRedirectUri('javascript:alert(1)', { allowPrivateUseSchemes: true })).toBe(false);
    expect(isSafeRedirectUri('not-a-url', { allowPrivateUseSchemes: false })).toBe(false);
  });
});

describe('isClientIdMetadataUrl: printable-ASCII-only', () => {
  it('refuses a bidi override, a zero-width space, or a control character in the CIMD URL', () => {
    for (const evil of [`https://client.example/${RLO}profile.json`, `https://client.example/${ZWSP}profile.json`, 'https://client.example/\x00profile.json']) {
      expect(isClientIdMetadataUrl(evil), JSON.stringify(evil)).toBe(false);
    }
  });

  it('still accepts the identical byte percent-encoded, and leaves every existing rule (userinfo, path, fragment, dot-segments) exactly as before', () => {
    expect(isClientIdMetadataUrl('https://client.example/%E2%80%AEprofile.json')).toBe(true);
    expect(isClientIdMetadataUrl('https://client.example/oauth/client.json')).toBe(true);
    expect(isClientIdMetadataUrl('https://client.example/c')).toBe(true);
    expect(isClientIdMetadataUrl('https://user:pw@client.example/c.json')).toBe(false); // credentials — unchanged, already refused
    // An empty userinfo leaves no trace in the parsed URL, so it is caught on the raw string.
    expect(isClientIdMetadataUrl('https://:@attacker.example/c.json')).toBe(false);
    expect(isClientIdMetadataUrl('https://@attacker.example/c.json')).toBe(false);
    expect(isClientIdMetadataUrl('https://client.example')).toBe(false); // no path — unchanged
    expect(isClientIdMetadataUrl('https://client.example/a/../c.json')).toBe(false); // dot segment — unchanged
  });
});

describe('isPrintableAsciiUri', () => {
  it('is the one rule both isSafeRedirectUri and isClientIdMetadataUrl share', () => {
    expect(isPrintableAsciiUri('https://client.example/c.json')).toBe(true);
    expect(isPrintableAsciiUri(`https://client.example/${RLO}`)).toBe(false);
    expect(isPrintableAsciiUri('')).toBe(false); // empty — nothing printable to accept
  });
});

describe('escapeInvisibles', () => {
  it('turns Cc, Cf, U+2028 and U+2029 into a visible \\u{...} escape', () => {
    expect(escapeInvisibles(`a${RLO}b`)).toBe('a\\u{202e}b');
    expect(escapeInvisibles(`a${LRI}b`)).toBe('a\\u{2066}b');
    expect(escapeInvisibles(`a${ZWSP}b`)).toBe('a\\u{200b}b');
    expect(escapeInvisibles('a\x00b')).toBe('a\\u{0}b');
    expect(escapeInvisibles('a\tb')).toBe('a\\u{9}b');
    expect(escapeInvisibles(`a${LS}b${PS}c`)).toBe('a\\u{2028}b\\u{2029}c');
  });

  it('leaves plain text, a boundary character, and a percent-encoded byte untouched', () => {
    expect(escapeInvisibles('nothing unusual here')).toBe('nothing unusual here');
    expect(escapeInvisibles('a b')).toBe('a b'); // space is Zs, not Cc/Cf — a different category, left alone here
    expect(escapeInvisibles('https://app.example.com/cb%E2%80%AEx')).toBe('https://app.example.com/cb%E2%80%AEx');
  });

  it('has nothing to do when given an empty string', () => {
    expect(escapeInvisibles('')).toBe('');
  });
});

describe('renderIdentity: the rendering layer is a second, independent guard', () => {
  it('shows all three fields — resource, clientId, redirect URI — as a visible escape, never the raw bidi/control character', () => {
    const html = renderIdentity(`https://app.example.com/cb${RLO}x`, {
      resource: `https://hub.example.com/hub${ZWSP}`,
      clientId: `https://client.example/${RLO}profile.json`
    });
    expect(html).toContain('\\u{202e}');
    expect(html).toContain('\\u{200b}');
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(ZWSP);
  });

  it('escapes a line/paragraph separator too, so it cannot break the line HTML would otherwise let it break', () => {
    const html = renderIdentity(`https://app.example.com/cb${LS}next-looking-line`, {});
    expect(html).toContain('\\u{2028}');
    expect(html).not.toContain(LS);
  });

  it('renders an ordinary identity byte-identical to before this fix', () => {
    const identity = { resource: 'https://hub.example.com/hub', clientId: 'https://client.example/oauth/client.json' };
    const redirectUri = 'https://app.example.com/cb';
    const expected = [
      '  <p class="label">Requested access</p>',
      `  <code class="target">${escapeHtml(identity.resource)}</code>`,
      '  <p class="label">Identified by</p>',
      `  <code class="target">${escapeHtml(identity.clientId)}</code>`,
      '  <p class="label">Codes will be sent to</p>',
      `  <code class="target">${escapeHtml(redirectUri)}</code>`
    ].join('\n');
    expect(renderIdentity(redirectUri, identity)).toBe(expected);
  });

  it('has nothing to hide with no clientId at all (the loopback-only shape, unaffected by either fix)', () => {
    const html = renderIdentity('http://127.0.0.1:1/cb', { loopbackOnly: true });
    expect(html).not.toContain('Identified by');
    expect(html).toContain('any program running here could be the one asking');
  });
});

describe('validateDocument: CIMD document validation shares the same redirect_uri checks', () => {
  const CLIENT_ID = 'https://client.example/profile.json';
  const goodDocument = (redirectUris: string[]) => ({
    client_id: CLIENT_ID,
    client_name: 'consent identity cimd client',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none'
  });

  it('refuses a document whose redirect_uris carries userinfo, an empty userinfo, or a bidi/control character', () => {
    expect(() => validateDocument(goodDocument(['https://claude.ai@attacker.example/cb']), CLIENT_ID)).toThrow();
    expect(() => validateDocument(goodDocument(['https://:@attacker.example/cb']), CLIENT_ID)).toThrow();
    expect(() => validateDocument(goodDocument([`https://good.example/cb${RLO}x`]), CLIENT_ID)).toThrow();
    expect(() => validateDocument(goodDocument(['https://good.example/cb\x00x']), CLIENT_ID)).toThrow();
  });

  it('still accepts a document with ordinary https redirect_uris, "@" in a path and percent-encoded', () => {
    const client = validateDocument(goodDocument(['https://good.example/cb', 'https://good.example/cb%40handle', 'https://good.example/@handle']), CLIENT_ID);
    expect(client.redirect_uris).toEqual(['https://good.example/cb', 'https://good.example/cb%40handle', 'https://good.example/@handle']);
  });
});

describe('POST /register (DCR create) refuses and accepts through the real path', () => {
  const register = (redirectUri: string) =>
    request(hub.app)
      .post('/register')
      .send({ redirect_uris: [redirectUri], client_name: 'consent-identity', token_endpoint_auth_method: 'none' });

  it('refuses a redirect_uri with userinfo, including the empty ":@" form', async () => {
    for (const uri of ['https://claude.ai@attacker.example/cb', 'https://:@attacker.example/cb']) {
      const response = await register(uri).expect(400);
      expect(response.body.error, uri).toBe('invalid_redirect_uri');
    }
  });

  it('refuses a redirect_uri with a bidi override or a control character', async () => {
    for (const uri of [`https://app.example.com/cb${RLO}x`, 'https://app.example.com/cb\x00x']) {
      const response = await register(uri).expect(400);
      expect(response.body.error, uri).toBe('invalid_redirect_uri');
    }
  });

  it('still accepts an ordinary https redirect_uri, a loopback address on an arbitrary port, a private-use scheme, and an "@" in the path', async () => {
    for (const uri of ['https://app.example.com/cb-ok', 'http://127.0.0.1:58211/cb', 'com.example.app:/cb', 'https://app.example.com/@handle/cb']) {
      const response = await register(uri).expect(201);
      expect(response.body.redirect_uris, uri).toEqual([uri]);
    }
  });

  it('a legitimate flow still authorizes end to end afterwards', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT);
    const { code } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT,
      resource: 'http://localhost:3000/hub'
    });
    expect(code).toBeTruthy();
  });
});

describe('RFC 7592 PUT (DCR update) refuses and accepts through the real path', () => {
  interface Registration {
    client_id: string;
    registration_access_token: string;
    registration_client_uri: string;
  }

  async function register(): Promise<Registration> {
    const response = await request(hub.app)
      .post('/register')
      .send({ redirect_uris: [REDIRECT], client_name: 'consent-identity-put', token_endpoint_auth_method: 'none' })
      .expect(201);
    return response.body as Registration;
  }

  const put = (registration: Registration, body: Record<string, unknown>) =>
    request(hub.app)
      .put(new URL(registration.registration_client_uri).pathname)
      .set('Authorization', `Bearer ${registration.registration_access_token}`)
      .send(body);

  it('refuses an update to a redirect_uri with userinfo and leaves the stored registration untouched', async () => {
    const registration = await register();
    const response = await put(registration, { client_id: registration.client_id, redirect_uris: ['https://claude.ai@attacker.example/cb'] }).expect(400);
    expect(response.body.error).toBe('invalid_client_metadata');
    expect(hub.store.getClient(registration.client_id)?.redirect_uris).toEqual([REDIRECT]);
  });

  it('refuses an update to a redirect_uri with a bidi override and leaves the stored registration untouched', async () => {
    const registration = await register();
    await put(registration, { client_id: registration.client_id, redirect_uris: [`https://app.example.com/cb${RLO}x`] }).expect(400);
    expect(hub.store.getClient(registration.client_id)?.redirect_uris).toEqual([REDIRECT]);
  });

  it('still accepts an ordinary update to a new https redirect_uri', async () => {
    const registration = await register();
    const response = await put(registration, { client_id: registration.client_id, redirect_uris: ['https://app.example.com/moved'] }).expect(200);
    expect(response.body.redirect_uris).toEqual(['https://app.example.com/moved']);
  });
});
