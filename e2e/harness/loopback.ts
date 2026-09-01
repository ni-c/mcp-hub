import net from 'node:net';

/**
 * Refuses any target that is not on this machine.
 *
 * This is the one guard that matters more than the tests it protects. The
 * suite mints tokens, revokes clients, rewrites configuration and kills
 * processes, and the machine it is written on is usually the machine that also
 * has a *real* hub configured — a deployed one, behind a VPN, with live
 * connectors attached. One `EXTERNAL_URL` inherited from a shell is all it
 * would take.
 *
 * A hard throw, never a skip. A skipped test reads as "nothing to do here",
 * which is exactly the wrong report when the reason is "this was pointed
 * somewhere it must never go".
 *
 * Ported from `mcp-integration-harness/src/loopback.ts`, which builds the same
 * check on the published `mcp-internal-hosts`. Reimplemented rather than
 * depended on: this repository ships no runtime dependency it does not need,
 * and the loopback half is twenty lines. The spellings below are the reason it
 * is not a string comparison — `[::ffff:127.0.0.1]` is canonicalised by `URL`
 * to `[::ffff:7f00:1]` before anything else sees it, `localhost.` carries a root
 * label, and a prefix check on `127.` would also accept `127.example.com`,
 * which is a public hostname anyone may register.
 */
export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `mcp-hub e2e: refusing to talk to ${host}. This suite revokes credentials, ` +
        'rewrites configuration and kills processes, and may only ever do that to ' +
        'a throwaway hub on this machine. Expected a loopback host.'
    );
  }
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  // A trailing root label is the same name; `localhost.` is a legal spelling.
  if (bare === 'localhost' || bare === 'localhost.') return true;

  const version = net.isIP(bare);
  if (version === 4) return bare.split('.')[0] === '127';
  if (version !== 6) return false;

  if (bare === '::1') return true;
  // IPv4-mapped: ::ffff:127.0.0.1 and the hex form URL rewrites it to.
  const mapped = /^::ffff:(.+)$/.exec(bare)?.[1];
  if (mapped === undefined) return false;
  if (net.isIPv4(mapped)) return mapped.split('.')[0] === '127';
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
  if (!hex) return false;
  return Number.parseInt(hex[1], 16) >>> 8 === 127;
}

/** {@link assertLoopbackHost}, for a target addressed by URL. */
export function assertLoopback(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`mcp-hub e2e: refusing to run against "${url}" — not a URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // `new URL('localhost:7690')` succeeds, with protocol `localhost:` and an
    // empty hostname. Without this branch the next check rejects it for having
    // no host, and the message reads "refusing to talk to " with a hole where
    // the name should be — true, and no help at all to whoever forgot `http://`.
    throw new Error(
      `mcp-hub e2e: refusing to run against "${url}" — not an http(s) URL. A ` +
        'scheme-less "localhost:7690" parses as a URL whose protocol is ' +
        '"localhost:", which is not the same thing as a hub.'
    );
  }
  assertLoopbackHost(parsed.hostname);
}
