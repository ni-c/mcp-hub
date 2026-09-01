#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

import { startGateway } from '../harness/gateway.js';
import { readTranscript, replayTranscript, type TranscriptEntry } from '../harness/replay.js';
import { catalogueFleet } from '../fixtures/fleets.js';

/**
 * Turns a raw capture into a golden that is deterministic by construction.
 *
 * This is the most important tool in the transcript design, and the reasoning
 * is short: a recorded response contains fields that differ every run — dates,
 * ids, nonces, session handles — and a golden that asserts them is a golden
 * that fails on the second Tuesday and gets re-recorded rather than read.
 *
 * So the capture is replayed **twice** against a fresh hub, and only the fields
 * that were identical both times are kept as the expectation. Anything that
 * moved between two runs of the same input is nondeterministic by definition
 * and must not be asserted. What survives is provably stable *before* it lands,
 * rather than plausible on the day it was taken.
 *
 *   npm run e2e:curate -- --file e2e/transcripts/chatgpt/connector-add.jsonl
 */

/**
 * Response headers the HTTP layer generates rather than the hub.
 *
 * The two-run intersection is the right mechanism and it has one blind spot:
 * a value that is stable *within a second* looks deterministic. `date` is the
 * clearest case — two replays a moment apart agree on it, and the third one
 * tomorrow does not. `etag` and `content-length` derive from a body that
 * contains the port, so they move whenever the port does.
 *
 * None of them says anything about the hub's protocol behaviour, which is the
 * same reasoning that drops `host` and `connection` on the request side.
 * Everything else stays under the intersection rule.
 */
const GENERATED_HEADERS = new Set(['date', 'etag', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

function intersect(a: unknown, b: unknown): unknown {
  if (a === null || typeof a !== 'object') return Object.is(a, b) ? a : undefined;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return undefined;
    const kept = a.map((item, index) => intersect(item, b[index])).filter(item => item !== undefined);
    return kept.length > 0 ? kept : undefined;
  }
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(a as Record<string, unknown>)) {
    const agreed = intersect(value, (b as Record<string, unknown>)[key]);
    if (agreed !== undefined) out[key] = agreed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function main(): Promise<void> {
  const index = process.argv.indexOf('--file');
  const file = index === -1 ? undefined : process.argv[index + 1];
  if (!file) {
    console.error('curate: --file <transcript.jsonl> is required');
    process.exit(2);
  }
  const entries = readTranscript(path.resolve(file));

  const runs: Array<Array<{ body: unknown; headers: unknown }>> = [];
  // Every run gets a different port, and the responses are full of it — issuer,
  // resource identifier, every endpoint URL. Substituted back to the
  // placeholder the replayer expands, or the golden would only ever pass on the
  // port that happened to be free the day it was curated.
  const generalise = (value: unknown, externalUrl: string): unknown =>
    JSON.parse(JSON.stringify(value ?? null).split(JSON.stringify(externalUrl).slice(1, -1)).join('${EXTERNAL_URL}')) as unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const gateway = await startGateway({
      prefix: `curate-${attempt}`,
      tier: 'process',
      servers: catalogueFleet('modern'),
      env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '10000' }
    });
    try {
      const result = await replayTranscript(gateway, stripExpectations(entries));
      runs.push(
        result.responses.map(response => ({
          body: generalise(response.json ?? response.events?.[0]?.json ?? response.text, gateway.externalUrl),
          // Headers get the same two-run treatment as the body, and for the
          // same reason: `date` and `etag` are different every time, and a
          // golden that asserted them would fail on its first replay. Anything
          // that survived both runs is a header the hub really does send the
          // same way each time — which is exactly the set worth pinning.
          headers: generalise(
            Object.fromEntries([...(response.headers ?? [])].filter(([name]) => !GENERATED_HEADERS.has(name.toLowerCase()))),
            gateway.externalUrl
          )
        }))
      );
    } finally {
      await gateway.stop();
    }
  }

  let step = 0;
  const curated = entries.map(entry => {
    if (entry.t !== 'http') return entry;
    const first = runs[0][step] as { body: unknown; headers: unknown };
    const second = runs[1][step] as { body: unknown; headers: unknown };
    step += 1;
    return {
      ...entry,
      res: {
        status: entry.res.status,
        headers: (intersect(first.headers, second.headers) ?? {}) as Record<string, string>,
        jsonSubset: intersect(first.body, second.body)
      }
    };
  });

  fs.writeFileSync(path.resolve(file), `${curated.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  console.error(`curate: kept the fields both runs agreed on across ${step} step(s) in ${file}`);
}

/** Replays without asserting, so a raw capture can be run at all. */
function stripExpectations(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map(entry => (entry.t === 'http' ? { ...entry, res: {} } : entry));
}

void main();
