import { defineConfig } from 'vitest/config';

/**
 * The end-to-end suite: a hub in another process, or in a container, driven by
 * a real client over real HTTP.
 *
 * Separate from `vitest.config.ts` rather than a `projects` entry, because a
 * bare `vitest run` would then run every project and `npm test` would have to
 * grow a `--project` flag. Two configs keep the fast suite's command literally
 * unchanged, which is the point: that one is the PR gate and this one is not.
 */
export default defineConfig({
  test: {
    include: ['e2e/suites/**/*.e2e.ts'],
    // The preflight decides whether the environment can host the tiers it was
    // asked for, and every other file assumes it already passed.
    sequence: { hooks: 'stack' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // A retry hides a flake rather than fixing it, and a flaky end-to-end suite
    // is muted within a month. Everything that waits does so through
    // `waitFor(predicate, deadline)`; nothing sleeps a fixed amount.
    retry: 0,
    pool: 'forks',
    // Each file starts its own hub, its own children and — at the docker tier —
    // its own compose project. Four at once is what a CI runner takes before
    // the spawns start competing for CPU and the timing assertions get noisy.
    maxWorkers: 4,
    // Deliberately off. The thresholds in vitest.config.ts are enforced by the
    // `test (24)` job, which is a required status check on main; a number
    // produced by a nightly run that no pull request performs could not be
    // answered with tests, only by lowering the gate.
    coverage: { enabled: false },
    reporters: ['default', './e2e/harness/budget-reporter.ts']
  }
});
