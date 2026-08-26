import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { filterTools, hasToolFilter, toolAllowed, unmatchedPatterns } from '../src/tool-filter.js';

const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } });
const TOOLS = ['list_a', 'list_b', 'get_a', 'delete_a'].map(tool);

describe('toolAllowed', () => {
  it('lets everything through when nothing is configured', () => {
    for (const t of TOOLS) expect(toolAllowed({}, t.name)).toBe(true);
  });

  it('keeps only what an allow list names', () => {
    const config = { allowTools: ['list_a', 'get_a'] };
    expect(TOOLS.filter(t => toolAllowed(config, t.name)).map(t => t.name)).toEqual(['list_a', 'get_a']);
  });

  it('matches a whole family with a trailing star', () => {
    expect(filterTools({ allowTools: ['list_*'] }, TOOLS).map(t => t.name)).toEqual(['list_a', 'list_b']);
  });

  it('subtracts the deny list from the allow list', () => {
    const config = { allowTools: ['list_*'], denyTools: ['list_b'] };
    expect(filterTools(config, TOOLS).map(t => t.name)).toEqual(['list_a']);
  });

  it('lets deny win over allow for the same name', () => {
    expect(toolAllowed({ allowTools: ['get_a'], denyTools: ['get_a'] }, 'get_a')).toBe(false);
  });

  it('matches exactly, not as a substring', () => {
    // `list_a` must not be matched by `list` — only a trailing star widens it.
    expect(toolAllowed({ allowTools: ['list'] }, 'list_a')).toBe(false);
    expect(toolAllowed({ allowTools: ['*'] }, 'list_a')).toBe(true);
  });

  it('treats an empty allow list as "no tools", not as "unset"', () => {
    // The distinction is load-bearing: [] is the one-token way to cut a server
    // off, while an absent key means everything. A length check would conflate
    // the two, which is the easiest bug in this feature.
    expect(hasToolFilter({ allowTools: [] })).toBe(true);
    expect(toolAllowed({ allowTools: [] }, 'list_a')).toBe(false);
    expect(toolAllowed({}, 'list_a')).toBe(true);
  });

  it('returns the same array when there is nothing to filter', () => {
    expect(filterTools({}, TOOLS)).toBe(TOOLS);
  });
});

describe('unmatchedPatterns', () => {
  it('reports only entries that match no tool at all', () => {
    const config = { allowTools: ['list_*', 'nope'], denyTools: ['delete_a', 'zzz_*'] };
    expect(unmatchedPatterns(config, TOOLS)).toEqual(['nope', 'zzz_*']);
  });

  it('says nothing when every entry matched', () => {
    expect(unmatchedPatterns({ allowTools: ['list_*'] }, TOOLS)).toEqual([]);
  });
});

describe('parsing allowTools and denyTools', () => {
  const parse = (entry: Record<string, unknown>) =>
    parseConfig(JSON.stringify({ mcpServers: { a: { command: 'x', ...entry } } })).get('a');

  it('accepts arrays of names and patterns', () => {
    expect(parse({ allowTools: ['list_*', 'get_a'], denyTools: ['delete_a'] })).toMatchObject({
      allowTools: ['list_*', 'get_a'],
      denyTools: ['delete_a']
    });
  });

  it('emits no keys at all when neither is set', () => {
    // Guards every whole-object assertion in config.test.ts: an unconditional
    // key here would break them all.
    const parsed = parse({});
    expect(parsed).not.toHaveProperty('allowTools');
    expect(parsed).not.toHaveProperty('denyTools');
  });

  it('applies to every server kind, not just the lifecycled ones', () => {
    // keepAlive and idleMinutes are rejected on remote and socket servers; the
    // tool filter must not be routed through that same guard, because an
    // upstream you do not control is the strongest case for filtering it.
    const remote = parseConfig(
      JSON.stringify({ mcpServers: { a: { type: 'http', url: 'http://x/mcp', denyTools: ['delete_*'] } } })
    ).get('a');
    expect(remote).toMatchObject({ kind: 'remote', denyTools: ['delete_*'] });
  });

  it('rejects a value that is not an array of strings', () => {
    expect(() => parse({ allowTools: 'list_a' })).toThrow(/must be an array of strings/);
    expect(() => parse({ denyTools: [1] })).toThrow(/must be an array of strings/);
  });

  it('rejects an empty entry', () => {
    expect(() => parse({ allowTools: [''] })).toThrow(/must not contain an empty string/);
  });

  it('rejects a star anywhere but last', () => {
    // This is the one typo class that is decidable without the upstream, and it
    // would otherwise match nothing forever without ever saying so.
    expect(() => parse({ allowTools: ['*_a'] })).toThrow(/only a trailing "\*" is supported/);
    expect(() => parse({ denyTools: ['li*st'] })).toThrow(/only a trailing "\*" is supported/);
  });
});
