import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

const env = { TOKEN: 't' };
const parse = (servers: Record<string, unknown>) => {
  const warnings: string[] = [];
  parseConfig(JSON.stringify({ mcpServers: servers }), env, { warn: message => warnings.push(message) });
  return warnings;
};

describe('keys the hub ignores', () => {
  it('names a misspelt key, without its value', () => {
    expect(parse({ ssh: { command: 'ssh-mcp', unlok: { secret: 'value' } } })).toEqual([
      'mcp-hub: server "ssh" has a key the hub ignores: "unlok" — check for a typo'
    ]);
  });

  it('names every one of them in one line', () => {
    expect(parse({ a: { url: 'https://example.invalid/mcp', alwaysAllow: [], disabled: true } })).toEqual([
      'mcp-hub: server "a" has keys the hub ignores: "alwaysAllow", "disabled" — check for a typo'
    ]);
  });

  it('judges a key by the kind of server, not by any kind', () => {
    expect(parse({ socket: { type: 'unix', socket: '/run/x.sock', image: 'x' } })).toEqual([
      'mcp-hub: server "socket" has a key the hub ignores: "image" — check for a typo'
    ]);
  });

  it('says nothing about keys every kind of server knows', () => {
    expect(
      parse({
        stdio: { type: 'stdio', command: 'x', args: [], env: {}, hub: false, keepAlive: true, allowTools: ['a'], denyTools: ['b'], passthrough: 'off', subscriptions: 'off' },
        remote: { type: 'http', url: 'https://example.invalid/mcp', headers: {}, oauth: { mode: 'dcr', grant: 'authorization_code' } },
        docker: {
          type: 'docker',
          image: 'img@sha256:' + 'a'.repeat(64),
          pull: 'never',
          command: ['x'],
          entrypoint: ['y'],
          env: {},
          volumes: [],
          ports: [],
          network: 'none',
          memory: '256m',
          pidsLimit: 10,
          cpus: 1,
          readOnly: true,
          tmpfs: [],
          user: '1000:1000',
          idleMinutes: 5
        },
        unix: { type: 'unix', socket: '/run/x.sock' },
        tcp: { type: 'tcp', host: '127.0.0.1', port: 9000 }
      })
    ).toEqual([]);
  });

  it('stays quiet without a listener', () => {
    expect(() => parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x', typo: 1 } } }), env)).not.toThrow();
  });
});
