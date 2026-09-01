/**
 * Did the suite actually reach everything the hub offers?
 *
 * Ported from `mcp-integration-harness/src/coverage.ts` — the same three
 * directions, pointed at a gateway's aggregated catalogue instead of one
 * server's. Copied rather than depended on: that package is unpublished and
 * resolved through a filesystem symlink, which a public repository's `npm ci`
 * cannot do.
 */

/**
 * The reason a tool could not be exercised.
 *
 * A `Record<tool, reason>` rather than a `string[]`, and that is the whole
 * design. A bare list lets a tool be dropped from the suite by adding six
 * characters, and nothing afterwards can tell a deliberate omission from a
 * forgotten one. A reason has to be written by a person, which is a small cost
 * exactly where a small cost is useful.
 *
 * A reason that has earned its place:
 *
 *   crash_now: 'kills its server; the chaos suite calls it deliberately'
 *
 * One that has not:
 *
 *   delete_everything: 'skipped'
 */
export type SkipReasons = Readonly<Record<string, string>>;

export interface CoverageReport {
  called: readonly string[];
  skipped: readonly string[];
  /** In the catalogue, neither called nor given a reason. */
  missing: readonly string[];
  /** Given a reason, but called anyway — the reason is stale. */
  staleReasons: readonly string[];
  /** Given a reason, but no longer a tool — the reason outlived its tool. */
  unknownReasons: readonly string[];
}

/**
 * Compares what ran against the catalogue, without asserting.
 *
 * Separate from the assertion so a caller can print the numbers: "31 of 34
 * tools exercised through /hub, 3 excused" is worth having in a nightly log
 * even on a green run.
 */
export function toolCoverage(called: ReadonlySet<string>, allTools: readonly string[], skipped: SkipReasons): CoverageReport {
  const catalogue = new Set(allTools);
  const reasons = Object.keys(skipped);
  return {
    called: [...called].sort(),
    skipped: reasons.sort(),
    missing: allTools.filter(tool => !called.has(tool) && !(tool in skipped)).sort(),
    staleReasons: reasons.filter(tool => called.has(tool)).sort(),
    unknownReasons: reasons.filter(tool => !catalogue.has(tool)).sort()
  };
}

/**
 * Fails unless every tool in the catalogue was called or excused.
 *
 * Three directions, not one, because a coverage check that only looks for gaps
 * rots from the other end:
 *
 *   1. A tool neither called nor excused — the gap everyone expects.
 *   2. An excused tool that *was* called. The reason is now false, and a false
 *      reason is worse than none: the next person reads it and believes the
 *      tool cannot be tested.
 *   3. An excused tool that no longer exists. It was renamed or removed and its
 *      excuse stayed behind, quietly making the exception list look longer than
 *      the real one.
 */
export function expectEveryToolExercised(called: ReadonlySet<string>, allTools: readonly string[], skipped: SkipReasons = {}): void {
  const report = toolCoverage(called, allTools, skipped);
  const problems: string[] = [];

  if (report.missing.length > 0) {
    problems.push(
      `${report.missing.length} tool(s) never called and not excused: ${report.missing.join(', ')}. ` +
        'Call them, or give each a reason in the skip map saying what prevents it.'
    );
  }
  if (report.staleReasons.length > 0) {
    problems.push(
      `${report.staleReasons.length} excused tool(s) were called after all: ${report.staleReasons.join(', ')}. ` +
        'Remove the reason — it is no longer true.'
    );
  }
  if (report.unknownReasons.length > 0) {
    problems.push(`${report.unknownReasons.length} reason(s) name a tool that no longer exists: ${report.unknownReasons.join(', ')}.`);
  }

  if (problems.length > 0) {
    throw new Error(
      `${report.called.length} of ${allTools.length} tools exercised, ${report.skipped.length} excused.\n\n${problems.join('\n\n')}`
    );
  }
}
