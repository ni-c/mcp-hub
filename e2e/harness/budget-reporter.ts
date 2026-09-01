import type { Reporter } from 'vitest/reporters';

/**
 * Fails the run when the suite got slower than anybody agreed to.
 *
 * A nightly suite has no natural pressure to stay fast: nobody waits for it, so
 * it grows a minute at a time until it takes forty and somebody turns it off.
 * The ceiling makes that growth visible on the run that causes it, while the
 * cause is still one commit away.
 *
 * It also reports the test count, which is the other half of the same problem.
 * A tier that quietly stopped running looks exactly like a tier that passed;
 * a floor turns "0 tests, all green" into a failure. The floor is deliberately
 * low — it catches "nothing ran", not "not enough ran", and a real assertion
 * about coverage belongs in the tests themselves.
 */
export default class BudgetReporter implements Reporter {
  private started = 0;

  onInit(): void {
    this.started = Date.now();
  }

  onTestRunEnd(testModules: readonly { children: { allTests(): Iterable<unknown> } }[], errors: readonly unknown[]): void {
    const elapsed = Date.now() - this.started;
    const budget = Number(process.env.MCPHUB_E2E_BUDGET_MS ?? 15 * 60_000);
    const floor = Number(process.env.MCPHUB_E2E_MIN_TESTS ?? 1);

    let tests = 0;
    for (const module of testModules) for (const _ of module.children.allTests()) tests += 1;

    const tiers = process.env.MCPHUB_E2E_TIERS ?? '(default)';
    console.log(`\nmcp-hub e2e: ${tests} test(s) across tier(s) ${tiers} in ${(elapsed / 1000).toFixed(1)}s`);

    // Only complain about a green run: on a red one the failure is the news,
    // and a second failure about the clock buries it.
    if (errors.length > 0) return;

    if (tests < floor) {
      throw new Error(
        `mcp-hub e2e: only ${tests} test(s) ran, below the floor of ${floor}. ` +
          'A suite that runs nothing reports the same green as one that runs everything.'
      );
    }
    if (Number.isFinite(budget) && budget > 0 && elapsed > budget) {
      throw new Error(
        `mcp-hub e2e: the run took ${(elapsed / 1000).toFixed(1)}s, over the ` +
          `${(budget / 1000).toFixed(0)}s budget. Something started waiting instead of polling, ` +
          'or a timing constant is being elapsed rather than configured — see src/timings.ts.'
      );
    }
  }
}
