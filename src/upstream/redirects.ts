import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/server';
import { logSafe } from '../auth/text.js';

/**
 * Redirects on the data plane of a remote upstream, followed only within the
 * origin the operator configured.
 *
 * `fetch` follows a 3xx by default, and neither the SDK's transports nor the
 * hub's own wrappers said otherwise — so a remote MCP server could answer a
 * `tools/call`, the SSE stream or a `subscriptions/listen` with a `Location`
 * pointing at an internal address, and the hub would connect there, send the
 * JSON-RPC body and every configured header except `Authorization` and
 * `Cookie` (the two the platform strips across origins), and parse whatever
 * came back as MCP. The control plane — discovery, token, registration — has
 * refused redirects since the guard for the authorization server was written;
 * this closes the same door on the other side.
 *
 * Same origin is the line, not same host: a different port on the same name
 * is a different service, and a plain-http twin of an https upstream is not
 * the upstream. Within that line a hop is followed because servers really do
 * redirect `/mcp` to `/mcp/`, and refusing it would break upstreams that were
 * never a problem.
 */
export const MAX_REDIRECT_HOPS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Ceiling on one message from a remote upstream: the same limit the
 * byte-stream transports apply (`src/transports/stream.ts`), because a remote
 * server is no more trusted than a sandboxed one. It bounds a JSON reply as a
 * whole and an event stream per event, so a long-lived stream is never cut
 * off for its length.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = STDIO_DEFAULT_MAX_BUFFER_SIZE;

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType !== null && contentType.split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
}

/**
 * Passes bytes through until more than `maxBytes` have gone by, then errors
 * the stream, so `.json()` or the SDK's SSE reader fails instead of buffering
 * without end. For an event stream the count restarts at every blank line —
 * the event separator, in any mix of CR, LF and CRLF. A CR at the end of a
 * chunk may be the first half of a CRLF, so `sawCR` carries it into the next.
 */
function budgetedStream(maxBytes: number, sse: boolean): TransformStream<Uint8Array, Uint8Array> {
  let sinceBoundary = 0;
  let sawCR = false;
  let terminatorRun = 0;

  // One line terminator (`\r`, `\n` or `\r\n`) completed. Two in a row with no
  // content byte between them is a blank line — the event boundary.
  const closeTerminator = (): void => {
    if (++terminatorRun < 2) return;
    sinceBoundary = 0;
    terminatorRun = 0;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sse) {
        sinceBoundary += chunk.byteLength;
        if (sinceBoundary > maxBytes) {
          controller.error(new Error(`upstream response exceeds the ${maxBytes} byte limit`));
          return;
        }
        controller.enqueue(chunk);
        return;
      }
      for (let i = 0; i < chunk.byteLength; i++) {
        sinceBoundary++;
        if (sinceBoundary > maxBytes) {
          controller.error(new Error(`upstream SSE event exceeds the ${maxBytes} byte limit`));
          return;
        }
        const byte = chunk[i]!;
        if (byte === 0x0d) {
          if (sawCR) closeTerminator();
          sawCR = true;
        } else if (byte === 0x0a) {
          closeTerminator();
          sawCR = false;
        } else {
          if (sawCR) closeTerminator();
          sawCR = false;
          terminatorRun = 0;
        }
      }
      controller.enqueue(chunk);
    }
  });
}

/**
 * Puts the final response's body under the budget above. A JSON reply that
 * declares more than the limit in `content-length` is refused before reading;
 * an event stream's length describes the connection, not one event, so it is
 * not consulted there.
 */
function capResponseBody(response: Response, maxBytes: number): Response {
  if (!response.body) return response;
  const sse = isEventStream(response);
  if (!sse) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void response.body.cancel().catch(() => {});
      throw new Error(`upstream declared a ${declared} byte response, exceeding the ${maxBytes} byte limit`);
    }
  }
  return new Response(response.body.pipeThrough(budgetedStream(maxBytes, sse)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/**
 * Wraps a fetch so that every redirect it would follow is checked first and
 * the response it returns is byte-budgeted.
 *
 * `origin` is the configured upstream's origin (`new URL(config.url).origin`).
 * The returned function has the platform's shape and can be handed to the SDK
 * transports as their `fetch`; every hop goes through `fetchImpl`, so a wrapper
 * that adds headers still adds them on each hop. `maxBytes` is a parameter so
 * tests can exercise the budget without megabytes of fixtures.
 */
export function boundedRedirectFetch(origin: string, fetchImpl: typeof fetch = fetch, maxBytes: number = MAX_UPSTREAM_RESPONSE_BYTES): typeof fetch {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    let request: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      // A caller that built a Request keeps it on the first hop — its body
      // lives there. Nothing in the hub does, but the shape is the platform's.
      const response = await fetchImpl(hop === 0 && input instanceof Request ? new Request(input, request) : url, request);
      if (!REDIRECT_STATUSES.has(response.status)) return capResponseBody(response, maxBytes);
      const location = response.headers.get('location');
      if (location === null) return capResponseBody(response, maxBytes);
      // Nothing of the redirect's body is wanted, and holding the stream open
      // would keep the connection with it.
      await response.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new Error(`upstream at ${logSafe(url.origin)} redirected to an unparseable location`);
      }
      if (next.origin !== origin) {
        throw new Error(
          `upstream at ${logSafe(url.origin)} redirected to ${logSafe(next.origin)} — refused, redirects are followed only within the configured origin`
        );
      }
      if (hop + 1 >= MAX_REDIRECT_HOPS) {
        throw new Error(`upstream at ${logSafe(url.origin)} redirected more than ${MAX_REDIRECT_HOPS} times`);
      }
      // A fragment on the request URL survives a redirect that has none.
      if (!next.hash && url.hash) next.hash = url.hash;
      url = next;
      request = nextRequest(request, response.status);
    }
  };
}

/**
 * What the platform would do to the method and body on this hop (Fetch
 * standard, "HTTP-redirect fetch"): a 303 always becomes a GET, a 301 or 302
 * turns a POST into a GET, and a 307 or 308 keeps both. The body is dropped
 * whenever the method changes, with the headers that only described it.
 */
function nextRequest(request: RequestInit, status: number): RequestInit {
  const method = (request.method ?? 'GET').toUpperCase();
  const becomesGet = status === 303 ? method !== 'GET' && method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST';
  if (!becomesGet) return request;
  const headers = new Headers(request.headers);
  for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) {
    headers.delete(name);
  }
  return { ...request, method: 'GET', body: undefined, headers };
}
