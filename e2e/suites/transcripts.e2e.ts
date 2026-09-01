import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { catalogueFleet } from '../fixtures/fleets.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { assertHasPurpose, listTranscripts, readTranscript, replayTranscript } from '../harness/replay.js';
import { tierEnabled } from '../harness/tiers.js';
import { REPO_ROOT } from '../harness/workspace.js';

/**
 * Replays what real clients sent, and keeps the collection honest.
 *
 * The second half is the one that survives contact with time. A golden that
 * breaks is re-recorded rather than read unless something stops that, so this
 * file also fails on a transcript with no stated purpose and on a run that
 * rewrote one — see `e2e/transcripts/README.md`.
 *
 * The directory is allowed to be nearly empty. A hosted client cannot reach
 * loopback, so ChatGPT and claude.ai have to be captured against a deployed hub
 * and replayed here; three real captures beat eight invented ones, which would
 * assert only what somebody already believed. What must never be empty is the
 * tooling, and that is what the first two tests cover.
 */

const RUNS_HERE = tierEnabled('process');
const TRANSCRIPTS = path.join(REPO_ROOT, 'e2e', 'transcripts');
const files = listTranscripts(TRANSCRIPTS);

let gateway: Gateway;

beforeAll(async () => {
  if (!RUNS_HERE || files.length === 0) return;
  gateway = await startGateway({
    prefix: 'transcripts',
    tier: 'process',
    servers: catalogueFleet('modern'),
    env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '10000' }
  });
}, 120_000);

afterAll(() => gateway?.stop());

describe.runIf(RUNS_HERE)('the transcript collection', () => {
  it('says what each of its files is for', () => {
    // Runs even when the directory is empty, which is the point: it is the
    // guard that has to be in place *before* the first capture lands, or the
    // first capture lands without a purpose and sets the precedent.
    for (const file of files) assertHasPurpose(path.relative(REPO_ROOT, file), readTranscript(file));
  });

  it('has tooling that can be pointed at a client today', () => {
    // A promise the README makes; a missing script would turn "capture one"
    // into an afternoon of archaeology.
    const scripts = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['e2e:record']).toBeDefined();
    expect(scripts['e2e:curate']).toBeDefined();
    expect(fs.existsSync(path.join(REPO_ROOT, 'e2e', 'tools', 'record.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'e2e', 'tools', 'curate.ts'))).toBe(true);
  });
});

describe.runIf(RUNS_HERE && files.length > 0)('replaying real clients', () => {
  for (const file of files) {
    const name = path.relative(TRANSCRIPTS, file);
    it(`serves ${name} the way it was served when it was captured`, async () => {
      const entries = readTranscript(file);
      const result = await replayTranscript(gateway, entries);
      expect(result.steps).toBeGreaterThan(0);
    }, 120_000);
  }
});
