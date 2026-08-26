import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * An HTTPS request that connects to an address someone already vetted.
 *
 * Checking a hostname and then handing it to `fetch` leaves a gap: the check
 * resolves the name once, `fetch` resolves it again, and a DNS zone the caller
 * controls can answer differently the second time. A short TTL alternating
 * between a public address and `169.254.169.254` wins that race reliably. The
 * only way to close it is to stop resolving twice — so the vetted address is
 * pinned into the connection here, while the hostname is still what TLS
 * validates the certificate against.
 *
 * Deliberately `node:https` rather than a custom `fetch` dispatcher: undici is
 * not a dependency of this project, and its `Agent` would be the only reason
 * to add one.
 */

/** Answers every lookup with the one address that was already checked. */
export function pinnedLookup(address: string): LookupFunction {
  const family = net.isIP(address);
  return ((hostname: string, options: unknown, callback: unknown) => {
    const done = (typeof options === 'function' ? options : callback) as (
      error: Error | null,
      addressOrResults: string | { address: string; family: number }[],
      family?: number
    ) => void;
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) done(null, [{ address, family }]);
    else done(null, address, family);
  }) as unknown as LookupFunction;
}

export interface GuardedRequestOptions {
  /** The checked address to connect to; the hostname still drives SNI. */
  pinnedAddress: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  /** Defaults to GET. Token and registration endpoints need POST. */
  method?: string;
  body?: string;
}

export async function guardedRequest(url: URL, options: GuardedRequestOptions): Promise<Response> {
  // Only https reaches this in production — the caller rejects anything else
  // before resolving. Plain http is here so the transport can be exercised
  // without a certificate authority, and for the local-development escape hatch.
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    // Declared up here because finish() may run before the timer below is
    // assigned — an immediate connection error would otherwise hit the
    // temporal dead zone instead of rejecting.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | undefined, response?: Response): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(response!);
    };

    const request = transport.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        // No compression: this path decodes nothing, and a compressed body
        // would make the byte cap below measure the wrong thing.
        headers: {
          ...options.headers,
          host: url.host,
          'accept-encoding': 'identity',
          ...(options.body !== undefined ? { 'content-length': String(Buffer.byteLength(options.body)) } : {})
        },
        lookup: pinnedLookup(options.pinnedAddress)
      },
      response => {
        const status = response.statusCode ?? 0;
        // The caller asked for no redirects; a hop would be resolved and
        // connected without going through the address check again.
        if (status >= 300 && status < 400) {
          response.destroy();
          request.destroy();
          finish(new Error(`refused to follow a redirect (HTTP ${status})`));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          request.destroy();
          finish(new Error(`response exceeds ${options.maxBytes} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            response.destroy();
            request.destroy();
            finish(new Error(`response exceeds ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', error => finish(error));
        response.on('end', () => {
          if (settled) return;
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            try {
              if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
              else headers.set(key, value);
            } catch {
              // A header the Fetch API will not represent is not one this
              // caller reads; dropping it beats failing the whole request.
            }
          }
          // A zero-length body has to be null: Response refuses an empty
          // buffer for the statuses that may not carry one.
          finish(undefined, new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, { status, headers }));
        });
      }
    );

    // Bounds the whole exchange, not just socket inactivity — a body trickled
    // a byte at a time would otherwise keep the request alive indefinitely.
    deadline = setTimeout(() => {
      request.destroy(new Error(`timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    request.on('error', error => finish(error));
    request.end(options.body);
  });
}
