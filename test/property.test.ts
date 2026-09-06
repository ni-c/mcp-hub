import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_MESSAGE_BYTES,
  MAX_ROUNDS,
  openRequestState,
  sanitiseInputRequests,
  sanitiseText,
  sealRequestState,
  type ElicitationState
} from '../src/elicitation.js';

/**
 * Properties of the elicitation trust boundary.
 *
 * `elicitation.test.ts` names the cases someone thought of. Everything below
 * crosses a boundary where the examples are chosen by an attacker rather than
 * by us: the text was written by a child server and is shown to a person as if
 * the hub were asking, and the sealed state goes out to a client and comes
 * back. What has to hold there is a statement about *every* input, which is
 * what a property is for.
 *
 * The first block is also the evidence behind a dismissed CodeQL alert.
 * `js/overly-large-range` flags the character class in `sanitiseText` as
 * probably a typo for a narrower one, and it was dismissed on the argument that
 * the breadth *is* the requirement. That argument is a claim about behaviour,
 * and until now nothing checked it. These tests are what make it a fact.
 */

const RUNS = { numRuns: 500 };

const SECRET = 'test-secret';
const BINDING = {
  server: 'smtp',
  tool: 'send_mail',
  clientId: 'client-1',
  via: 'server'
} as const;

/**
 * The characters `sanitiseText` exists to remove, built from code points rather
 * than written out — the source file deliberately carries none of them, and a
 * test that pasted them in would be the one place they live in the tree.
 */
const UNSAFE_CODE_POINTS = [
  ...range(0x00, 0x08), // C0, minus tab, newline and carriage return
  0x0b,
  0x0c,
  ...range(0x0e, 0x1f),
  0x7f, // DEL
  ...range(0x200b, 0x200f), // zero-width and directional marks
  ...range(0x202a, 0x202e), // bidi embedding and override
  0x2060, // word joiner
  ...range(0x2066, 0x2069), // bidi isolates
  0xfeff // BOM
];

/** The three control characters a prompt may legitimately contain. */
const SAFE_CONTROLS = ['\t', '\n', '\r'];

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const unsafeChar = fc
  .constantFrom(...UNSAFE_CODE_POINTS)
  .map((code) => String.fromCodePoint(code));

/** Text with unsafe characters sprinkled through it, as a hostile child writes it. */
const hostileText = fc
  .array(fc.oneof(fc.string(), unsafeChar), { maxLength: 40 })
  .map((parts) => parts.join(''));

describe('sanitiseText removes exactly what it claims', () => {
  /**
   * Nothing that can misrepresent the text's own shape survives.
   *
   * This is the whole argument for the width of the class: a bidi override
   * reverses the attribution line so `Server "x" asks:` renders as something
   * else, and a zero-width character hides content from the reader that the
   * model still sees. Stated over every one of the 44 code points rather than
   * over the handful an example test would list.
   */
  it('no unsafe character survives, wherever it sat', () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        const clean = sanitiseText(text);
        for (const code of UNSAFE_CODE_POINTS) {
          expect(clean).not.toContain(String.fromCodePoint(code));
        }
      }),
      RUNS
    );
  });

  /**
   * Stripping is idempotent, which is what makes it safe to compose.
   *
   * `sanitiseInputRequests` runs it on the server name and again on the
   * message, then concatenates the two. If a second pass could produce
   * something a first pass would have removed — a pair of halves splicing into
   * a new character — the prefix would be forgeable after the fact.
   */
  it('is idempotent', () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        const once = sanitiseText(text);
        expect(sanitiseText(once)).toBe(once);
      }),
      RUNS
    );
  });

  /**
   * It removes and never rewrites.
   *
   * The counterpart to the property above: a sanitiser that *replaced*
   * characters could introduce something, and one that reordered could change
   * meaning without removing anything. Deleting is the only operation that is
   * safe to state this simply, and the class being wide costs nothing precisely
   * because of it.
   */
  it('is a subsequence of its input, never a rewrite', () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        const clean = sanitiseText(text);
        let index = 0;
        for (const character of clean) {
          index = text.indexOf(character, index);
          expect(index).toBeGreaterThanOrEqual(0);
          index += character.length;
        }
      }),
      RUNS
    );
  });

  it('leaves tab, newline and carriage return alone', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SAFE_CONTROLS), { maxLength: 20 }), (parts) => {
        const text = parts.join('');
        expect(sanitiseText(text)).toBe(text);
      }),
      RUNS
    );
  });
});

describe('the attribution prefix cannot be forged', () => {
  /**
   * Whatever the child writes, the message the person sees opens with the hub's
   * own sentence naming the server.
   *
   * This is the property the sanitiser exists to serve, and it is stated on the
   * function a caller actually reaches rather than on the helper underneath.
   */
  it('every forwarded message opens with the hub naming the server', () => {
    fc.assert(
      fc.property(hostileText, hostileText, (serverName, message) => {
        const { requests } = sanitiseInputRequests(
          { ask: { method: 'elicitation/create', params: { message } } } as never,
          serverName
        );
        const params = (requests as Record<string, { params: { message: string } }>).ask?.params;
        expect(params?.message.startsWith(`Server "${sanitiseText(serverName)}" asks:`)).toBe(true);
      }),
      RUNS
    );
  });

  /**
   * The byte budget holds for every message, including the ones that would
   * split a multi-byte character at the cut.
   *
   * `clampBytes` reserves three bytes for the ellipsis — reserving one was an
   * off-by-two — and drops the U+FFFD that a cut through a character leaves
   * behind. Both are size arithmetic, which is exactly what a property finds
   * and an example misses.
   */
  it('a forwarded message never exceeds the byte budget, and carries no replacement glyph', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8000, unit: 'grapheme' }),
        fc.string({ maxLength: 60 }),
        (message, serverName) => {
          const { requests } = sanitiseInputRequests(
            { ask: { method: 'elicitation/create', params: { message } } } as never,
            serverName
          );
          const text = (requests as Record<string, { params: { message: string } }>).ask?.params
            ?.message;
          expect(Buffer.byteLength(text ?? '', 'utf8')).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
          expect(text).not.toContain('�');
        }
      ),
      RUNS
    );
  });

  /**
   * `_meta` is removed whatever it holds, and nothing but an elicitation is
   * carried whatever it is called.
   *
   * A progress token forwarded from a child collides with the client's own id
   * space; an embedded `sampling/createMessage` spends the caller's model
   * budget on a child's prompt. Both are refusals rather than repairs, so the
   * property is that they do not appear on the other side at all.
   */
  it('drops _meta and every method that is not an elicitation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.jsonValue(),
        (method, meta) => {
          fc.pre(method !== 'elicitation/create');
          const { requests, dropped } = sanitiseInputRequests(
            {
              other: { method, params: {} },
              ask: {
                method: 'elicitation/create',
                params: { message: 'hello', _meta: meta }
              }
            } as never,
            'server'
          );
          expect(dropped).toContain('other');
          const params = (requests as Record<string, { params: Record<string, unknown> }>).ask
            ?.params;
          expect(params).toBeDefined();
          expect('_meta' in (params ?? {})).toBe(false);
        }
      ),
      RUNS
    );
  });
});

describe('the sealed state binds all of itself', () => {
  const validState = (overrides: Partial<ElicitationState> = {}): ElicitationState => ({
    ...BINDING,
    round: 0,
    expiresAt: Date.now() + 60_000,
    ...overrides
  });

  it('a state this hub sealed opens again unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_ROUNDS - 1 }),
        fc.option(fc.string(), { nil: undefined }),
        (round, upstream) => {
          const original = validState({ round, upstream });
          const opened = openRequestState(
            sealRequestState(original, SECRET),
            SECRET,
            BINDING
          );
          expect(opened?.round).toBe(round);
          expect(opened?.upstream).toBe(upstream);
        }
      ),
      RUNS
    );
  });

  /**
   * Every part of the binding is load-bearing.
   *
   * A state minted for one server, tool, client or route may not resume
   * another. Four fields is four chances to check three of them and mean to
   * check the fourth — so the property varies one at a time and expects the
   * same refusal each time.
   */
  it('a state does not open against a different binding', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('server', 'tool', 'clientId', 'via'),
        fc.string({ minLength: 1, maxLength: 12 }),
        (field, other) => {
          fc.pre(other !== BINDING[field as keyof typeof BINDING]);
          const token = sealRequestState(validState(), SECRET);
          expect(
            openRequestState(token, SECRET, { ...BINDING, [field]: other })
          ).toBeUndefined();
        }
      ),
      RUNS
    );
  });

  /**
   * Nothing this hub did not sign opens at all.
   *
   * The signature is the only thing standing between a client editing its own
   * round counter and the loop cap meaning nothing.
   */
  it('a mutated or foreign token never opens', () => {
    const token = sealRequestState(validState(), SECRET);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: token.length - 1 }),
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'),
        (index, character) => {
          const mutated = token.slice(0, index) + character + token.slice(index + 1);
          fc.pre(mutated !== token);
          expect(openRequestState(mutated, SECRET, BINDING)).toBeUndefined();
        }
      ),
      RUNS
    );
  });

  it('a token signed with another secret never opens', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (otherSecret) => {
        fc.pre(otherSecret !== SECRET);
        const token = sealRequestState(validState(), otherSecret);
        expect(openRequestState(token, SECRET, BINDING)).toBeUndefined();
      }),
      RUNS
    );
  });

  it('an expired or spent state never opens', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_ROUNDS, max: MAX_ROUNDS + 50 }),
        fc.integer({ min: 1, max: 600_000 }),
        (spentRound, ago) => {
          const now = Date.now();
          expect(
            openRequestState(
              sealRequestState(validState({ round: spentRound }), SECRET),
              SECRET,
              BINDING,
              now
            )
          ).toBeUndefined();
          expect(
            openRequestState(
              sealRequestState(validState({ expiresAt: now - ago }), SECRET),
              SECRET,
              BINDING,
              now
            )
          ).toBeUndefined();
        }
      ),
      RUNS
    );
  });
});
