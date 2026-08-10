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
      command: 'npx',
      args: ['-y', 'paperless-mcp'],
      env: { PAPERLESS_API_TOKEN: 'secret123' },
      hub: true
    });
    expect(config.get('plain')?.env).toEqual({});
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
    [{ mcpServers: { a: { type: 'http', url: 'https://example.com' } } }, 'only stdio'],
    [{ mcpServers: { a: { url: 'https://example.com' } } }, 'only stdio'],
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
