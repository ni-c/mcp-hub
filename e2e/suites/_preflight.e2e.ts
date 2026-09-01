import { describe, expect, it } from 'vitest';

import { assertDockerUsable, dockerWasPromised, hasDockerSocket } from '../harness/docker.js';
import { assertLoopback, isLoopbackHost } from '../harness/loopback.js';
import { band } from '../harness/ports.js';
import { enabledTiers, TIERS } from '../harness/tiers.js';
import { assertBuildIsFresh } from '../harness/workspace.js';

/**
 * Runs first and fails rather than skips.
 *
 * Everything below is a precondition the rest of the suite silently assumes,
 * and every one of them fails in a way that looks like something else if it is
 * not checked here: a stale `dist/` looks like the fix not working, a missing
 * daemon looks like a green run, a non-loopback target looks like nothing at
 * all until the first `clients revoke`.
 *
 * The filename sorts first, which is a convenience rather than a guarantee —
 * vitest runs files in parallel. The checks are therefore also made where they
 * matter (`startGateway` re-checks the build), and this file exists to give
 * them one obvious place to be read.
 */
describe('preflight', () => {
  it('was told which tiers to run', () => {
    const tiers = enabledTiers();
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) expect(TIERS).toContain(tier);
    console.log(`mcp-hub e2e: tiers ${tiers.join(', ')}`);
  });

  it('has a build that is not older than the source', () => {
    // Only the spawned tiers execute dist/, but checking unconditionally keeps
    // the failure in one place: an inproc-only run that would have passed
    // against a stale build tells you now rather than on the next full run.
    assertBuildIsFresh();
  });

  it.runIf(enabledTiers().includes('docker'))('can reach a Docker daemon', async () => {
    await assertDockerUsable();
  });

  it('fails loudly when Docker was promised and is missing', () => {
    // The inverse of the check above, and the reason MCPHUB_EXPECT_DOCKER
    // exists at all: the nightly's docker job sets it, so a runner that lost
    // its daemon produces a red job instead of a green one that ran nothing.
    if (dockerWasPromised()) expect(hasDockerSocket).toBe(true);
  });

  it('gives each concurrent worker a port band of its own', () => {
    // The bands are what keep two workers from choosing the same port, and the
    // scheme fails silently when it is keyed on the wrong variable: everything
    // passes until two files run at once. Asserted here so the next person to
    // touch it finds out immediately.
    const mine = band();
    expect(mine.to - mine.from).toBe(199);
    expect(mine.from).toBeGreaterThanOrEqual(20_000);
    if (process.env.VITEST_POOL_ID) {
      expect(mine.from).toBe(20_000 + (Number(process.env.VITEST_POOL_ID) - 1) * 200);
    }
  });

  it('refuses any target that is not on this machine', () => {
    // Not a test of a helper so much as a standing statement of the rule. The
    // suite revokes credentials and kills processes; one inherited EXTERNAL_URL
    // is all it would take to do that to something real.
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost.')).toBe(true);
    expect(isLoopbackHost('[::ffff:7f00:1]')).toBe(true);
    expect(isLoopbackHost('127.example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(() => assertLoopback('https://mcp-hub.ni-c.de/hub')).toThrow(/refusing to talk to/);
    expect(() => assertLoopback('localhost:7690')).toThrow(/not an http\(s\) URL/);
  });
});
