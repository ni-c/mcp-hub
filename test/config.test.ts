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
      hub: true
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
    const config = parseConfig(JSON.stringify({ mcpServers: { eve: { command: 'x', hub: false } } }), env);
    expect(config.get('eve')?.hub).toBe(false);
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
    [{ mcpServers: { a: { command: 'x', env: { A: '${DOES_NOT_EXIST}' } } } }, 'Undefined environment variable'],
    [{}, 'mcpServers']
  ])('rejects invalid config %#', (raw, message) => {
    expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(message);
    expect(() => parseConfig(JSON.stringify(raw), env)).toThrowError(ConfigError);
  });
});

describe('diffConfigs', () => {
  it('detects added, removed and changed servers', () => {
    const before = parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' }, c: { command: 'z' } } }), env);
    const after = parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y2' }, d: { command: 'w' } } }), env);
    expect(diffConfigs(before, after)).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] });
  });
});
