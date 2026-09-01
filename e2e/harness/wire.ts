import { REVISION, type Era } from './client.js';
import type { Gateway } from './gateway.js';

/**
 * HTTP without the SDK.
 *
 * The SDK client is the right tool for "does this work"; it is the wrong one
 * for "what exactly went over the wire", because it is built to smooth over
 * precisely the details a gateway has to get right. It picks the `Accept`
 * header, retries a failed modern probe as legacy, parses SSE back into
 * objects, and turns an HTTP status into an exception whose message no longer
 * mentions the status. Every one of those is a thing a client of the hub might
 * not do.
 *
 * So the conformance and transcript suites use this instead: a real `fetch`,
 * headers spelled the way a real client spells them, and both halves of a
 * failure — the HTTP status and the JSON-RPC error code — visible at once.
 */

export interface WireResponse {
  status: number;
  headers: Headers;
  text: string;
  /** Parsed body, when it was JSON. `undefined` for SSE or an empty body. */
  json?: unknown;
  /** Parsed SSE events, when the response was a stream. */
  events?: SseEvent[];
}

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
  json?: unknown;
}

export interface WireOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  token?: string;
  era?: Era;
  /** Sent verbatim. The default is what an SDK client sends. */
  accept?: string;
  signal?: AbortSignal;
}

export class WireClient {
  constructor(private readonly gateway: Gateway) {}

  async request(pathname: string, options: WireOptions = {}): Promise<WireResponse> {
    const headers: Record<string, string> = {
      // Spelled the way the SDK spells it, including the space after the comma:
      // a header the hub matches by substring would pass a rewritten one and
      // fail a real client's.
      accept: options.accept ?? 'application/json, text/event-stream',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.era ? { 'mcp-protocol-version': REVISION[options.era] } : {}),
      ...options.headers
    };
    const response = await fetch(`${this.gateway.baseUrl}${pathname}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
      redirect: 'manual',
      signal: options.signal ?? AbortSignal.timeout(30_000)
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const result: WireResponse = { status: response.status, headers: response.headers, text };
    if (contentType.includes('text/event-stream')) result.events = parseSse(text);
    else if (text && contentType.includes('application/json')) {
      try {
        result.json = JSON.parse(text);
      } catch {
        // Left undefined: a body that claims JSON and is not is itself a finding,
        // and `text` is right there for the assertion that says so.
      }
    }
    return result;
  }

  /** One JSON-RPC call, with the envelope spelled out rather than built by a client. */
  rpc(pathname: string, body: Record<string, unknown>, options: WireOptions = {}): Promise<WireResponse> {
    return this.request(pathname, { ...options, method: 'POST', body: { jsonrpc: '2.0', ...body } });
  }
}

/**
 * Parses an SSE body into its frames.
 *
 * Written against the wire format rather than reusing an SSE library, because
 * the framing itself is under test: whether `data:` lines carry a raw newline,
 * whether `id:` is present for resumption, whether keep-alive comments are sent
 * at all. A library would normalise away the very thing being asserted.
 */
export function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of body.split(/\n\n/)) {
    if (!block.trim()) continue;
    const event: SseEvent = { data: '' };
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // keep-alive comment
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') event.event = value;
      else if (field === 'id') event.id = value;
    }
    event.data = data.join('\n');
    try {
      event.json = JSON.parse(event.data);
    } catch {
      // Not every frame is JSON; the raw text stays available either way.
    }
    events.push(event);
  }
  return events;
}

/** How many keep-alive comment frames a body carries. Not visible after parsing. */
export function keepAliveCount(body: string): number {
  return body.split('\n').filter(line => line.startsWith(':')).length;
}

/**
 * Parses `WWW-Authenticate` into its parameters.
 *
 * Compared as a map, never as a string: the order of `error` and
 * `resource_metadata` is not specified, and a test that compared the whole
 * header would break on a reordering that no client can see.
 */
export function authenticateParams(header: string | null): Record<string, string> {
  if (!header) return {};
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1]] = match[2];
  return params;
}

/**
 * Deep "contains", the assertion the transcript suite is built on.
 *
 * Equality is the wrong shape for a response golden: the hub is allowed to add
 * a field, and a suite that failed on every addition would be re-recorded
 * rather than read. A subset walk still catches the two things that matter —
 * a field that disappeared and a value that changed — and makes object key
 * order irrelevant by construction rather than by convention.
 *
 * Arrays compare element-wise by index, because order in a JSON-RPC result is
 * usually meaningful (content parts, pagination). Where it is not, the caller
 * sorts first.
 */
export function matchesSubset(actual: unknown, expected: unknown, path = '$'): string[] {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${JSON.stringify(actual)}`];
    if (actual.length < expected.length) return [`${path}: expected at least ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((item, index) => matchesSubset(actual[index], item, `${path}[${index}]`));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return [`${path}: expected an object, got ${JSON.stringify(actual)}`];
  }
  const target = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) =>
    Object.hasOwn(target, key) ? matchesSubset(target[key], value, `${path}.${key}`) : [`${path}.${key}: missing`]
  );
}

export function expectSubset(actual: unknown, expected: unknown): void {
  const problems = matchesSubset(actual, expected);
  if (problems.length > 0) {
    throw new Error(`response did not contain the expected subset:\n${problems.map(p => `  - ${p}`).join('\n')}`);
  }
}
