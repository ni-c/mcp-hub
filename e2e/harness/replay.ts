import fs from 'node:fs';
import path from 'node:path';

import { authorizeInBrowser, registerPublicClient } from '../../test/auth-flow.js';
import type { Gateway } from './gateway.js';
import { REDIRECT_URI } from './token.js';
import { expectSubset, WireClient, type WireResponse } from './wire.js';

/**
 * Real clients' requests, replayed at a hub that has never met them.
 *
 * The point is the half an SDK hides. Every MCP client sends a slightly
 * different `Accept`, some send `MCP-Protocol-Version` and some do not, ChatGPT
 * wants a `client_secret` in a registration response it will never store, and
 * claude.ai opens a GET stream on every reconnect without ever closing a
 * session. A suite built on one SDK proves that SDK works.
 *
 * Two rules make this maintainable rather than a pile of snapshots:
 *
 *   1. **Requests replay verbatim.** Header order, casing and the exact spacing
 *      of `Accept` are the value, not an accident to be normalised away.
 *   2. **Responses are asserted as a subset, never as equality.** The hub may
 *      add a field; a golden that failed on every addition would be re-recorded
 *      rather than read, and a re-recorded golden asserts nothing. A subset
 *      walk still catches the two things that matter — a field that disappeared
 *      and a value that changed — and makes key order irrelevant by
 *      construction.
 *
 * A transcript is never hand-edited. Re-capture it (`npm run e2e:record`) or
 * re-derive it (`npm run e2e:curate`); a hand-patched golden degrades into
 * "what the hub does today", which is the opposite of what it is for.
 */

export interface TranscriptMeta {
  t: 'meta';
  /** Which client produced this, e.g. `chatgpt`, `claude-code`. */
  client: string;
  /** ISO date of capture. A transcript older than two releases is a liability. */
  captured: string;
  /** The client's own build, when it is knowable. */
  clientBuild?: string;
  /** Which hub version it was captured against. */
  hubVersion?: string;
  /** What the human did, in a sentence. Required — see `assertHasPurpose`. */
  did: string;
}

export interface HttpStep {
  t: 'http';
  step: number;
  req: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  res: { status?: number; headers?: Record<string, string>; jsonSubset?: unknown; absentHeaders?: string[] };
}

/**
 * The one step that cannot be replayed verbatim.
 *
 * A login page carries a CSRF token and a session cookie that are new every
 * run, so the recorded bytes are worthless. Handed to `authorizeInBrowser`
 * instead — explicitly, rather than fudged with a substitution that would look
 * like it was replaying something it was not.
 */
export interface AuthorizeStep {
  t: 'authorize';
  step: number;
  resource: string;
  consent?: 'approve' | 'deny';
}

export type TranscriptEntry = TranscriptMeta | HttpStep | AuthorizeStep;

export interface ReplayContext {
  EXTERNAL_URL: string;
  TOKEN?: string;
  CLIENT_ID?: string;
  SESSION?: string;
  [key: string]: string | undefined;
}

export function readTranscript(file: string): TranscriptEntry[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as TranscriptEntry);
}

export function listTranscripts(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(entry.parentPath, entry.name));
  }
  return files.sort();
}

/** Substitutes `${NAME}` from the live context, recursively. */
export function substitute<T>(value: T, context: ReplayContext): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (whole, name: string) => context[name] ?? whole) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, context)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)])) as unknown as T;
  }
  return value;
}

export interface ReplayResult {
  steps: number;
  responses: WireResponse[];
}

export async function replayTranscript(gateway: Gateway, entries: TranscriptEntry[]): Promise<ReplayResult> {
  const wire = new WireClient(gateway);
  const context: ReplayContext = { EXTERNAL_URL: gateway.externalUrl };
  const responses: WireResponse[] = [];
  let steps = 0;

  for (const entry of entries) {
    if (entry.t === 'meta') continue;

    if (entry.t === 'authorize') {
      const clientId = context.CLIENT_ID ?? (await registerPublicClient(gateway.target, REDIRECT_URI));
      const { code } = await authorizeInBrowser(gateway.target, clientId, {
        password: gateway.password,
        redirectUri: REDIRECT_URI,
        resource: substitute(entry.resource, context),
        consent: entry.consent
      });
      context.CLIENT_ID = clientId;
      context.CODE = code;
      steps += 1;
      continue;
    }

    const request = substitute(entry.req, context);
    const response = await wire.request(request.path, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      accept: request.headers?.accept ?? request.headers?.Accept
    });
    responses.push(response);
    steps += 1;

    const where = `${entry.step}: ${request.method} ${request.path}`;
    if (entry.res.status !== undefined && response.status !== entry.res.status) {
      throw new Error(`${where}: expected HTTP ${entry.res.status}, got ${response.status}\n${response.text.slice(0, 400)}`);
    }
    for (const [name, expected] of Object.entries(entry.res.headers ?? {})) {
      const actual = response.headers.get(name);
      if (actual === null || !actual.includes(substitute(expected, context))) {
        throw new Error(`${where}: header ${name} was ${JSON.stringify(actual)}, expected to contain ${JSON.stringify(expected)}`);
      }
    }
    for (const name of entry.res.absentHeaders ?? []) {
      if (response.headers.get(name) !== null) throw new Error(`${where}: header ${name} should be absent`);
    }
    if (entry.res.jsonSubset !== undefined) {
      const body = response.json ?? response.events?.[0]?.json;
      try {
        expectSubset(body, substitute(entry.res.jsonSubset, context));
      } catch (error) {
        throw new Error(`${where}: ${(error as Error).message}`);
      }
    }

    // Anything the transcript captured that later steps refer to.
    const body = response.json as Record<string, unknown> | undefined;
    if (typeof body?.client_id === 'string') context.CLIENT_ID = body.client_id;
    if (typeof body?.access_token === 'string') context.TOKEN = body.access_token;
  }

  return { steps, responses };
}

/**
 * A transcript with no stated purpose is a snapshot with no author.
 *
 * The failure mode this prevents is specific: a golden breaks, somebody
 * re-records it, and within six months every file asserts only that the hub
 * still does whatever it did last time anyone looked. A required sentence
 * saying what wire behaviour the file pins is the cheapest defence, and it is
 * the same discipline `SkipReasons` enforces one level down.
 */
export function assertHasPurpose(file: string, entries: TranscriptEntry[]): void {
  const meta = entries.find((entry): entry is TranscriptMeta => entry.t === 'meta');
  if (!meta) throw new Error(`${file}: no meta record. Every transcript says who produced it, when, and what they did.`);
  for (const field of ['client', 'captured', 'did'] as const) {
    if (!meta[field]?.trim()) throw new Error(`${file}: meta.${field} is empty.`);
  }
  if (meta.did.trim().length < 20 || /^(test|check|smoke|tbd)$/i.test(meta.did.trim())) {
    throw new Error(`${file}: meta.did is boilerplate ("${meta.did}"). Say what the client did and what this pins.`);
  }
}
