import { describe, expect, it } from 'vitest';

import { nonNegativeIntegerEnv, positiveIntegerEnv } from '../src/mcp-limits.js';

/**
 * The timing constants themselves are read once at import, so a test cannot
 * vary them here — that is the point of the module, and it is why the values
 * are set for a whole process rather than for a call.
 *
 * What is worth pinning is the contract they were moved for: that the defaults
 * are unchanged from the constants they replaced, and that a bad value falls
 * back rather than taking the process down. The second one matters because this
 * module sits on the request path; index.ts is the only place allowed to exit
 * over a bad environment, and a supervisor that died on a typo in
 * MCP_PING_INTERVAL_MS would take every server with it.
 */
describe('timings', () => {
  it('keeps the numbers the supervisor used before they moved', async () => {
    const timings = await import('../src/timings.js');
    expect(timings.BACKOFF_INITIAL_MS).toBe(1_000);
    expect(timings.BACKOFF_MAX_MS).toBe(5 * 60_000);
    expect(timings.BACKOFF_RESET_AFTER_MS).toBe(5 * 60_000);
    expect(timings.PING_INTERVAL_MS).toBe(60_000);
    expect(timings.PING_TIMEOUT_MS).toBe(30_000);
    expect(timings.WAKE_TIMEOUT_MS).toBe(120_000);
    expect(timings.MAX_UNUSED_RESTARTS).toBe(5);
    expect(timings.IDLE_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(timings.CONFIG_POLL_INTERVAL_MS).toBe(3_000);
  });

  it('leaves the minute knob in charge when IDLE_TIMEOUT_MS is unset', async () => {
    const { IDLE_TIMEOUT_MS } = await import('../src/timings.js');
    // 0 is "not set", never "never sleep" — that meaning belongs to
    // IDLE_TIMEOUT_MINUTES=0 and cannot be shared without losing one of them.
    expect(IDLE_TIMEOUT_MS).toBe(0);
  });

  describe('the parsers these constants are built from', () => {
    const cases: Array<[string, string]> = [
      ['not a number', 'seven'],
      ['a fraction', '1.5'],
      ['negative', '-1'],
      ['beyond a safe integer', '9007199254740993'],
      ['empty', '']
    ];

    for (const [what, raw] of cases) {
      it(`falls back rather than throwing when a value is ${what}`, () => {
        process.env.MCP_TIMINGS_PROBE = raw;
        try {
          expect(positiveIntegerEnv('MCP_TIMINGS_PROBE', 42)).toBe(42);
          expect(nonNegativeIntegerEnv('MCP_TIMINGS_PROBE', 42)).toBe(42);
        } finally {
          delete process.env.MCP_TIMINGS_PROBE;
        }
      });
    }

    it('accepts zero only where zero has a meaning', () => {
      process.env.MCP_TIMINGS_PROBE = '0';
      try {
        // A ping interval of 0 would busy-loop; an unused-restart budget of 0
        // means "do not retry", which is a thing an operator may want.
        expect(positiveIntegerEnv('MCP_TIMINGS_PROBE', 42)).toBe(42);
        expect(nonNegativeIntegerEnv('MCP_TIMINGS_PROBE', 42)).toBe(0);
      } finally {
        delete process.env.MCP_TIMINGS_PROBE;
      }
    });
  });
});
