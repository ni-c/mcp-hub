import path from 'node:path';

import type { Era } from '../harness/client.js';
import { REPO_ROOT } from '../harness/workspace.js';

/**
 * The `mcpServers` blocks the suites hand to `startGateway`.
 *
 * Named rather than written inline, for one reason that outlives convenience:
 * a fleet is the thing a test is about. "The catalogue on both eras" and "one
 * child that crashes and one that does not" are the setups, and a suite that
 * spelled them out would bury its subject in paths.
 *
 * `demo/servers/*` is deliberately absent from everything here except
 * `demoFleet`, which only the docker tier uses. Those three belong to the
 * public demo; wiring them into the general fixtures would mean a change to the
 * demo breaks unrelated tests, and a change to the tests quietly constrains the
 * demo. The docker tier's job *is* to test the shipped demo, so that is where
 * they are used and nowhere else.
 */

const FIXTURES = path.join(REPO_ROOT, 'e2e', 'fixtures', 'servers');
const DEMO = path.join(REPO_ROOT, 'demo', 'servers');
const TEST_FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');

export const EVERYTHING = path.join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist', 'index.js');

/** One stdio child, spelled the way `mcp.json` spells it. */
export function stdio(file: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [path.join(FIXTURES, file)], ...extra };
}

export function testFixture(file: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [path.join(TEST_FIXTURES, file)], ...extra };
}

export function demoServer(file: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [path.join(DEMO, file)], ...extra };
}

/**
 * The same catalogue on the era asked for.
 *
 * Always mounted under the name `catalogue`, whichever era it is, so a suite
 * parameterised by era needs no branching at the call site either.
 */
export function catalogueFleet(era: Era): Record<string, unknown> {
  return { catalogue: stdio(era === 'legacy' ? 'catalog-2025.mjs' : 'catalog-2026.mjs') };
}

/** Both catalogues at once, for the four-cell client-era x child-era matrix. */
export function bothCataloguesFleet(): Record<string, unknown> {
  return { legacy: stdio('catalog-2025.mjs'), modern: stdio('catalog-2026.mjs') };
}

/**
 * A fleet built to misbehave, with one well-behaved neighbour.
 *
 * The neighbour is the assertion: every chaos test ends with "and the rest of
 * the hub still works", which is the property that separates a contained
 * failure from an outage.
 */
export function chaosFleet(): Record<string, unknown> {
  return {
    healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }),
    crasher: stdio('crash-server.mjs'),
    hanger: stdio('hang-server.mjs'),
    noisy: stdio('noisy-stdout-server.mjs')
  };
}

export function limitsFleet(extra: Record<string, string> = {}): Record<string, unknown> {
  return {
    healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }),
    oversize: stdio('oversize-server.mjs', Object.keys(extra).length > 0 ? { env: extra } : {})
  };
}

/** The public demo's three servers — docker tier only. See the note above. */
export function demoFleet(): Record<string, unknown> {
  return {
    weather: demoServer('weather.mjs', { keepAlive: true }),
    tickets: demoServer('tickets.mjs'),
    docs: demoServer('docs.mjs')
  };
}

/** A third-party child with a wide catalogue, on the legacy era. */
export function everythingFleet(): Record<string, unknown> {
  return { everything: { command: process.execPath, args: [EVERYTHING] } };
}
