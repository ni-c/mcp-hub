import { describe } from 'vitest';

import { ERAS, type Era } from './client.js';

/**
 * The era as a test dimension rather than as a branch.
 *
 * The hub answers both protocol revisions from the same routes, and the class
 * of bug that produces is not "2026 is broken" but "2026 quietly behaves like
 * 2025". Two failures in a row came from exactly that shape: an era read from a
 * child that had not been woken yet, and a call option hardcoded on a path only
 * one era takes. Neither is visible to a suite that tests one era and assumes
 * the other.
 *
 * So: every shared suite runs twice, and the era is passed in rather than
 * chosen inside. The assertion that the hub actually agreed lives in
 * `ClientPool.connect` — see the note there — so no test can forget it.
 */

export function describeEachEra(title: string, body: (era: Era) => void, only?: readonly Era[]): void {
  for (const era of only ?? ERAS) {
    describe(`${title} [${era}]`, () => body(era));
  }
}

/**
 * The four cells of client era x child era.
 *
 * This is the cross product that pays for itself. A 2025 child reaching a 2026
 * client is the hub's actual selling point, and the two mixed cells are where
 * the bridging code lives — the same-era cells mostly prove the fixtures agree.
 */
export function describeEachEraPair(title: string, body: (clientEra: Era, childEra: Era) => void): void {
  for (const clientEra of ERAS) {
    for (const childEra of ERAS) {
      describe(`${title} [client ${clientEra} / child ${childEra}]`, () => body(clientEra, childEra));
    }
  }
}
