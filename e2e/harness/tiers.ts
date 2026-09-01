/**
 * Which shape of hub the suite is running against.
 *
 * The three differ in exactly one thing — where the process boundary is — and
 * that is the whole reason there are three:
 *
 *   inproc   `createHub()` in this process. Fast, and the only tier that can
 *            reach into the supervisor. Everything the fast suite in `test/`
 *            already does, so this tier is mostly a debugging switch: an L2
 *            failure reproduced here without the spawn is much easier to read.
 *   process  `node dist/index.js`, spawned. The built artifact, the `isMain`
 *            bootstrap, env parsing, signal handling, and — the one that
 *            actually caught a shipped bug — a second process holding the same
 *            state file.
 *   docker   the published image through `demo/compose.yml`. uid 1000, a
 *            read-only root filesystem, tini as pid 1, the healthcheck, the
 *            demo everybody is invited to run.
 *
 * The selection is a positive list, mirroring the hub's own
 * `CLIENT_REGISTRATION`: naming what you want reads better than disabling what
 * you do not, and it cannot silently grow when a tier is added.
 */
export const TIERS = ['inproc', 'process', 'docker'] as const;
export type Tier = (typeof TIERS)[number];

const VARIABLE = 'MCPHUB_E2E_TIERS';

function parse(raw: string): Tier[] {
  const names = raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  const unknown = names.filter(name => !(TIERS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`${VARIABLE}: unknown tier ${unknown.join(', ')}. Known tiers: ${TIERS.join(', ')}.`);
  }
  // Deduplicated and put back into TIERS order, so the report reads the same
  // whatever order the variable named them in.
  return TIERS.filter(tier => names.includes(tier));
}

/**
 * The tiers this run should exercise.
 *
 * In CI the variable is required, with no default at all. That is not
 * pedantry: a default would mean a workflow that lost its `env:` block keeps
 * reporting green while testing a third of what it claims to, and a suite whose
 * green is not trustworthy is worse than no suite. Locally the default is the
 * two cheap tiers, because a contributor without a Docker daemon should still
 * be able to run this.
 */
export function enabledTiers(): Tier[] {
  const raw = process.env[VARIABLE];
  if (raw === undefined || raw.trim() === '') {
    if (process.env.CI === 'true') {
      throw new Error(
        `${VARIABLE} is not set. In CI it has no default on purpose: a workflow ` +
          'that lost its env block would otherwise keep reporting green while ' +
          `running a fraction of the suite. Set it to one of: ${TIERS.join(', ')}.`
      );
    }
    return ['inproc', 'process'];
  }
  const tiers = parse(raw);
  if (tiers.length === 0) throw new Error(`${VARIABLE} named no known tier.`);
  return tiers;
}

export function tierEnabled(tier: Tier): boolean {
  return enabledTiers().includes(tier);
}

/**
 * The tier a suite gets when it does not ask for one.
 *
 * `process` wherever it is available: the real boundary is what this suite
 * exists for, and a test that passes in-process but not out of it is precisely
 * the class of bug the fast suite cannot see.
 */
export function defaultTier(): Tier {
  const tiers = enabledTiers();
  return tiers.includes('process') ? 'process' : tiers[0];
}

/**
 * Declares which tier a file runs at, and proves it.
 *
 * Call it at the top of every suite. It returns the tier when the run wants it
 * and `undefined` when it does not, so the caller can `describe.skipIf`. The
 * proving half is `assertTierInUse` below, which every gateway checks against —
 * without it, "the docker tier passed" and "the docker tier quietly ran
 * in-process" are the same green tick.
 */
export function tierFor(wanted: Tier): Tier | undefined {
  return tierEnabled(wanted) ? wanted : undefined;
}

export function assertTierInUse(expected: Tier, actual: Tier): void {
  if (expected !== actual) {
    throw new Error(
      `This suite asked for the "${expected}" tier and got "${actual}". A tier ` +
        'that silently substitutes another reports coverage it does not have.'
    );
  }
}
