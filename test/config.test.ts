import { describe, expect, it } from 'vitest';
import { parseConfig, diffConfigs, ConfigError } from '../src/config.js';

const env = { PAPERLESS_TOKEN: 'secret123' };

describe('parseConfig', () => {
  it('parses a Claude-Code-style mcpServers config 1:1', () => {
    const config = parseConfig(
      JSON.stringify({
        mcpServers: {
          paperless: { command: 'npx', args: ['-y', 'paperless-mcp'], env: { PAPERLESS_API_TOKEN: '${PAPERLESS_TOKEN}' } },
          plain: { command: 'sh', args: ['-c', 'exec my-server'] }
        }
      }),
      env
    );
    expect(config.get('paperless')).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', 'paperless-mcp'],
      env: { PAPERLESS_API_TOKEN: 'secret123' },
      hub: true,
      keepAlive: false
    });
    const plain = config.get('plain');
    expect(plain?.kind === 'stdio' && plain.env).toEqual({});
  });

  it('parses remote http/sse servers with header expansion', () => {
    const config = parseConfig(
      JSON.stringify({
        mcpServers: {
          ha: { type: 'http', url: 'http://192.168.1.1:8123/api/mcp', headers: { Authorization: 'Bearer ${PAPERLESS_TOKEN}' } },
          legacy: { type: 'sse', url: 'https://example.com/sse' },
          urlOnly: { url: 'https://example.com/mcp' }
        }
      }),
      env
    );
    expect(config.get('ha')).toEqual({
      kind: 'remote',
      transport: 'http',
      url: 'http://192.168.1.1:8123/api/mcp',
      headers: { Authorization: 'Bearer secret123' },
      hub: true
    });
    const legacy = config.get('legacy');
    expect(legacy?.kind === 'remote' && legacy.transport).toBe('sse');
    const urlOnly = config.get('urlOnly');
    expect(urlOnly?.kind === 'remote' && urlOnly.transport).toBe('http');
  });

  it('supports the hub:false opt-out extension', () => {
    const config = parseConfig(JSON.stringify({ mcpServers: { scraper: { command: 'x', hub: false } } }), env);
    expect(config.get('scraper')?.hub).toBe(false);
  });

  it('accepts explicit type stdio', () => {
    const config = parseConfig(JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'x' } } }), env);
    expect(config.get('a')?.command).toBe('x');
  });

  it.each([
    [{ mcpServers: { a: { type: 'http' } } }, 'need a "url"'],
    [{ mcpServers: { a: { type: 'websocket', url: 'https://example.com' } } }, 'unknown type'],
    [{ mcpServers: { a: { url: 'https://example.com', command: 'npx' } } }, 'mutually exclusive'],
    [{ mcpServers: { a: { url: 'not a url' } } }, 'not a valid URL'],
    [{ mcpServers: { a: {} } }, 'missing a "command"'],
    [{ mcpServers: { 'bad name': { command: 'x' } } }, 'invalid'],
    [{ mcpServers: { hub: { command: 'x' } } }, 'reserved'],
    [{ mcpServers: { health: { command: 'x' } } }, 'reserved'],
    [{ mcpServers: { livez: { command: 'x' } } }, 'reserved'],
    [{ mcpServers: { a: { command: 'x', env: { A: '${DOES_NOT_EXIST}' } } } }, 'Undefined environment variable'],
    [{}, 'mcpServers']
  ])('rejects invalid config %#', (raw, message) => {
    expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(message);
    expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(ConfigError);
  });

  it('parses keepAlive and idleMinutes on stdio and docker servers', () => {
    const config = parseConfig(
      JSON.stringify({
        mcpServers: {
          pinned: { command: 'x', keepAlive: true },
          lazy: { command: 'x', idleMinutes: 30 },
          plain: { command: 'x' },
          sandbox: { type: 'docker', image: 'img:1', idleMinutes: 5 }
        }
      }),
      env
    );
    expect(config.get('pinned')).toMatchObject({ keepAlive: true });
    expect(config.get('pinned')).not.toHaveProperty('idleMinutes');
    expect(config.get('lazy')).toMatchObject({ keepAlive: false, idleMinutes: 30 });
    expect(config.get('plain')).toMatchObject({ keepAlive: false });
    expect(config.get('sandbox')).toMatchObject({ kind: 'docker', keepAlive: false, idleMinutes: 5 });
  });

  describe('upstream OAuth', () => {
    const remote = (oauth: unknown, extra: Record<string, unknown> = {}) => ({
      mcpServers: { a: { type: 'http', url: 'https://example.com/mcp', oauth, ...extra } }
    });

    it('accepts a static client with a secret from the environment', () => {
      const config = parseConfig(
        JSON.stringify(remote({ mode: 'static', clientId: 'abc', clientSecret: '${PAPERLESS_TOKEN}', grant: 'client_credentials', scopes: ['read'] })),
        env
      );
      expect(config.get('a')).toMatchObject({
        oauth: { mode: 'static', clientId: 'abc', clientSecret: 'secret123', grant: 'client_credentials', scopes: ['read'] }
      });
    });

    it('defaults scopes to none rather than requiring them', () => {
      const config = parseConfig(JSON.stringify(remote({ mode: 'dcr', grant: 'authorization_code' })), env);
      expect(config.get('a')).toMatchObject({ oauth: { scopes: [] } });
    });

    it.each([
      [remote({ mode: 'nope', grant: 'authorization_code' }), '"oauth.mode" must be one of'],
      [remote({ mode: 'static', clientId: 'a', grant: 'implicit' }), '"oauth.grant" must be one of'],
      [remote({ mode: 'static', grant: 'authorization_code' }), '"oauth.clientId" is required'],
      [remote({ mode: 'dcr', clientId: 'a', grant: 'authorization_code' }), 'only applies to mode "static"'],
      [remote({ mode: 'dcr', clientSecret: 's', grant: 'authorization_code' }), 'only applies to mode "static"'],
      [remote({ mode: 'dcr', grant: 'authorization_code', scope: ['a'] }), 'unknown "oauth" field(s) scope'],
      [remote({ mode: 'dcr', grant: 'authorization_code', scopes: 'read' }), '"oauth.scopes" must be an array'],
      [remote({ mode: 'dcr', grant: 'authorization_code', clientAuth: 'basic' }), '"oauth.clientAuth" must be one of'],
      [
        remote({ mode: 'static', clientId: 'a', clientSecret: 's', grant: 'client_credentials', clientAuth: 'private_key_jwt' }),
        'cannot be combined with a clientSecret'
      ],
      [remote({ mode: 'static', clientId: 'a', grant: 'client_credentials', clientAuth: 'client_secret_post' }), 'needs a clientSecret'],
      [remote('yes'), '"oauth" must be an object'],
      [
        remote({ mode: 'dcr', grant: 'authorization_code' }, { headers: { Authorization: 'Bearer x' } }),
        'cannot both be set'
      ],
      [
        // Case-insensitively, because header names are not normalised anywhere.
        remote({ mode: 'dcr', grant: 'authorization_code' }, { headers: { authorization: 'Bearer x' } }),
        'cannot both be set'
      ]
    ])('rejects invalid oauth config %#', (raw, message) => {
      expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(message);
      expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(ConfigError);
    });

    it('accepts private_key_jwt without a shared secret', () => {
      const config = parseConfig(
        JSON.stringify(remote({ mode: 'cimd', grant: 'client_credentials', clientAuth: 'private_key_jwt' })),
        env
      );
      const oauth = (config.get('a') as { oauth: Record<string, unknown> }).oauth;
      expect(oauth.clientAuth).toBe('private_key_jwt');
      expect('clientSecret' in oauth).toBe(false);
    });

    it('leaves clientAuth unset when the authorization server should decide', () => {
      const config = parseConfig(JSON.stringify(remote({ mode: 'dcr', grant: 'authorization_code' })), env);
      expect((config.get('a') as { oauth: { clientAuth?: string } }).oauth.clientAuth).toBeUndefined();
    });

    it('leaves other headers alone beside oauth', () => {
      const config = parseConfig(
        JSON.stringify(remote({ mode: 'dcr', grant: 'authorization_code' }, { headers: { 'X-Tenant': 'acme' } })),
        env
      );
      expect(config.get('a')).toMatchObject({ headers: { 'X-Tenant': 'acme' }, oauth: { mode: 'dcr' } });
    });

    it('reserves the callback path segment', () => {
      expect(() => parseConfig(JSON.stringify({ mcpServers: { upstream: { command: 'x' } } }), env)).toThrowError('reserved');
    });
  });

  it.each([
    [{ mcpServers: { a: { command: 'x', keepAlive: 'yes' } } }, '"keepAlive" must be a boolean'],
    [{ mcpServers: { a: { command: 'x', idleMinutes: 0 } } }, '"idleMinutes" must be a positive integer'],
    [{ mcpServers: { a: { command: 'x', idleMinutes: 1.5 } } }, '"idleMinutes" must be a positive integer'],
    [{ mcpServers: { a: { command: 'x', keepAlive: true, idleMinutes: 5 } } }, 'mutually exclusive'],
    [{ mcpServers: { a: { type: 'http', url: 'https://example.com/mcp', keepAlive: true } } }, 'only supported on stdio and docker'],
    [{ mcpServers: { a: { type: 'http', url: 'https://example.com/mcp', idleMinutes: 5 } } }, 'only supported on stdio and docker'],
    [{ mcpServers: { a: { type: 'unix', socket: '/tmp/x.sock', keepAlive: true } } }, 'only supported on stdio and docker'],
    [{ mcpServers: { a: { type: 'tcp', host: 'h', port: 1, idleMinutes: 5 } } }, 'only supported on stdio and docker']
  ])('rejects invalid lifecycle config %#', (raw, message) => {
    expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(message);
    expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(ConfigError);
  });

  it('treats a keepAlive/idleMinutes edit as a change', () => {
    const before = parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x' } } }), env);
    const after = parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x', keepAlive: true } } }), env);
    expect(diffConfigs(before, after).changed).toEqual(['a']);
  });
});

describe('diffConfigs', () => {
  it('detects added, removed and changed servers', () => {
    const before = parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' }, c: { command: 'z' } } }), env);
    const after = parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y2' }, d: { command: 'w' } } }), env);
    expect(diffConfigs(before, after)).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] });
  });
});
