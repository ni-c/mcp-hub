import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { diffConfigs, parseConfig } from '../src/config.js';
import { Supervisor } from '../src/supervisor.js';
import { ToolCache } from '../src/tool-cache.js';
import { defaultDuration, describeLock, durationChoices, locksTool, locksWholeServer, unmatchedUnlockPatterns } from '../src/unlock/policy.js';
import type { UnlockPolicy } from '../src/unlock/policy.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const parse = (unlock: unknown, extra: Record<string, unknown> = {}) =>
  parseConfig(JSON.stringify({ mcpServers: { ssh: { command: 'ssh-mcp', unlock, ...extra } } }), {}).get('ssh')!;

describe('unlock in mcp.json', () => {
  it('is absent unless set, and false means the same', () => {
    expect(parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x' } } }), {}).get('a')).not.toHaveProperty('unlock');
    expect(parse(false)).not.toHaveProperty('unlock');
  });

  it('true locks every tool for up to four hours', () => {
    expect(parse(true).unlock).toEqual({ tools: ['*'], maxMinutes: 240 });
  });

  it('an object names the tools and the cap', () => {
    expect(parse({ tools: ['send_mail', 'reply_*'], maxMinutes: 60 }).unlock).toEqual({ tools: ['send_mail', 'reply_*'], maxMinutes: 60 });
    expect(parse({}).unlock).toEqual({ tools: ['*'], maxMinutes: 240 });
    expect(parse({ maxMinutes: 0 }).unlock).toEqual({ tools: ['*'], maxMinutes: 0 });
  });

  it.each([
    [null, '"unlock" must be true, false or an object'],
    ['yes', '"unlock" must be true, false or an object'],
    [[], '"unlock" must be true, false or an object'],
    [1, '"unlock" must be true, false or an object'],
    [{ tool: ['x'] }, 'unknown "unlock" field(s) "tool" (supported: tools, maxMinutes)'],
    [{ tools: [] }, '"unlock.tools" must name at least one tool'],
    [{ tools: 'x' }, '"unlock.tools" must be an array of strings'],
    [{ tools: [''] }, '"unlock.tools" must not contain an empty string'],
    [{ tools: ['a*b'] }, 'only a trailing "*" is supported'],
    [{ maxMinutes: -1 }, '"unlock.maxMinutes" must be a whole number from 0'],
    [{ maxMinutes: 241 }, '"unlock.maxMinutes" must be a whole number from 0'],
    [{ maxMinutes: 1.5 }, '"unlock.maxMinutes" must be a whole number from 0'],
    [{ maxMinutes: '60' }, '"unlock.maxMinutes" must be a whole number from 0']
  ])('refuses %j', (unlock, message) => {
    expect(() => parse(unlock)).toThrowError(message);
  });

  it('works on every kind of server', () => {
    const config = parseConfig(
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://example.invalid/mcp', unlock: true },
          sock: { type: 'unix', socket: '/run/x.sock', unlock: true },
          box: { type: 'docker', image: 'img@sha256:' + 'a'.repeat(64), unlock: { tools: ['run'] } }
        }
      }),
      {}
    );
    expect([...config.values()].map(entry => entry.unlock?.tools)).toEqual([['*'], ['*'], ['run']]);
  });

  it.each(['unlock', 'Unlock', 'UNLOCK'])('reserves the name %s for the unlock pages', name => {
    expect(() => parseConfig(JSON.stringify({ mcpServers: { [name]: { command: 'x' } } }), {})).toThrowError(`Server name "${name}" is reserved`);
  });

  it('is a key the hub knows, so it draws no typo warning', () => {
    const warnings: string[] = [];
    parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x', unlock: true } } }), {}, { warn: m => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});

describe('unlock policy', () => {
  const whole: UnlockPolicy = { tools: ['*'], maxMinutes: 240 };
  const listed: UnlockPolicy = { tools: ['send_mail', 'reply_*'], maxMinutes: 240 };

  it('tells a whole-server lock from a list', () => {
    expect(locksWholeServer(whole)).toBe(true);
    expect(locksWholeServer(listed)).toBe(false);
    expect(locksWholeServer(undefined)).toBe(false);
  });

  it('locks exactly the listed tools, by name or prefix', () => {
    expect(['send_mail', 'reply_mail', 'reply_', 'preview_mail', 'Send_mail', 'send_mail '].map(tool => locksTool(listed, tool))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false
    ]);
    expect(locksTool(whole, 'anything')).toBe(true);
    expect(locksTool(undefined, 'anything')).toBe(false);
  });

  it.each([
    [240, true, ['once', 15, 30, 60, 120, 240]],
    [240, false, [15, 30, 60, 120, 240]],
    [60, true, ['once', 15, 30, 60]],
    [90, true, ['once', 15, 30, 60, 90]],
    [10, true, ['once', 10]],
    [0, true, ['once']],
    [0, false, []]
  ])('with a cap of %i minutes and a call %s offers %j', (maxMinutes, hasCall, choices) => {
    expect(durationChoices({ tools: ['*'], maxMinutes }, hasCall)).toEqual(choices);
  });

  it.each([
    [['once', 15, 30, 60], 30],
    [['once', 15, 20], 20],
    [['once', 10], 10],
    [[60, 120], 60],
    [['once'], 'once'],
    [[], undefined]
  ])('preselects from %j: %j', (choices, expected) => {
    expect(defaultDuration(choices as never)).toBe(expected);
  });

  it('names the patterns that match no tool the server lists', () => {
    const tools = [{ name: 'send_mail' }, { name: 'preview_mail' }];
    expect(unmatchedUnlockPatterns({ tools: ['send_mail', 'reply_*', 'sned_mail'], maxMinutes: 30 }, tools)).toEqual(['reply_*', 'sned_mail']);
    expect(unmatchedUnlockPatterns(whole, [])).toEqual([]);
    expect(unmatchedUnlockPatterns(undefined, tools)).toEqual([]);
  });

  it('describes a lock for log lines and pages', () => {
    expect(describeLock(whole)).toBe('all tools');
    expect(describeLock(listed)).toBe('send_mail, reply_*');
  });
});

const config = (unlock: unknown) => parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x', ...(unlock === undefined ? {} : { unlock }) } } }), {});

describe('changing unlock settings', () => {
  it('retunes the server when only the settings move', () => {
    expect(diffConfigs(config({ tools: ['a'] }), config({ tools: ['a', 'b'], maxMinutes: 60 }))).toEqual({ added: [], removed: [], changed: [], retuned: ['a'] });
  });

  it('restarts the server when the lock comes or goes', () => {
    expect(diffConfigs(config(undefined), config(true))).toEqual({ added: [], removed: [], changed: ['a'] });
    expect(diffConfigs(config(true), config(undefined))).toEqual({ added: [], removed: [], changed: ['a'] });
  });

  it('sees no change between two spellings of the same lock', () => {
    expect(diffConfigs(config(true), config({ tools: ['*'], maxMinutes: 240 }))).toEqual({ added: [], removed: [], changed: [] });
  });

  it('keeps the tool snapshot of a server across a retune, and the fingerprint of a server without a lock as it was', () => {
    const plain = config(undefined).get('a')!;
    expect(ToolCache.fingerprint(plain)).toBe(createHash('sha256').update(JSON.stringify(plain)).digest('hex'));
    expect(ToolCache.fingerprint(config({ tools: ['a'] }).get('a')!)).toBe(ToolCache.fingerprint(config({ tools: ['b'], maxMinutes: 5 }).get('a')!));
    expect(ToolCache.fingerprint(config(true).get('a')!)).not.toBe(ToolCache.fingerprint(plain));
  });

  it('applies a retune to the running server without replacing it', async () => {
    const before = parseConfig(JSON.stringify({ mcpServers: { e: { command: process.execPath, args: [EVERYTHING], unlock: { tools: ['echo'] } } } }), {});
    const after = parseConfig(JSON.stringify({ mcpServers: { e: { command: process.execPath, args: [EVERYTHING], unlock: { tools: ['get-*'] } } } }), {});
    const supervisor = new Supervisor(before, { idleTimeoutMinutes: 0 });
    try {
      await supervisor.start();
      await supervisor.waitUntilSettled();
      const running = supervisor.get('e')!;
      await supervisor.applyDiff(after, diffConfigs(before, after));
      expect(supervisor.get('e')).toBe(running);
      expect(running.state).toBe('up');
      expect(running.config.unlock?.tools).toEqual(['get-*']);
    } finally {
      await supervisor.stop();
    }
  });
});
