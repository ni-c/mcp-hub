/**
 * Where an authorization code is allowed to land.
 *
 * Both registration mechanisms end up handing a code to a URL the client chose,
 * so both have to agree on which URLs are acceptable — they did not before:
 * a metadata document was held to https-or-loopback while a dynamically
 * registered client could name any scheme the SDK's three-entry denylist did
 * not happen to cover, plain `http://` to a remote host included.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Schemes a browser or the operating system would treat as executable content
 *  or local file access. Never a legitimate redirect target. */
const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Printable ASCII, 0x21 `!` through 0x7E `~`. A URI is an ASCII string by
 * definition (RFC 3986): a control character, a space or any non-ASCII code
 * point — a bidi override or a zero-width character included — belongs in one
 * only as `%XX`, and that encoding is itself inside this range.
 */
const PRINTABLE_ASCII_ONLY = /^[\x21-\x7E]+$/;

export function isPrintableAsciiUri(value: string): boolean {
  return PRINTABLE_ASCII_ONLY.test(value);
}

/**
 * Whether a URI names a user before its host, `https://claude.ai@evil.example`
 * being the reason: the reader's eye lands on the part before the `@`, the
 * browser connects to the part after it.
 *
 * Two checks, because each misses a spelling the other catches. The raw string
 * is needed for an empty userinfo, which the WHATWG parser drops without a
 * trace (`https://:@host` parses to an empty username and password). The parsed
 * URL is needed for authorities the parser finds by another spelling, such as
 * a backslash in place of a slash (`https:/\user@host`). An `@` in the path
 * or query, or percent-encoded, is not userinfo and stays allowed.
 */
export function hasUserinfo(uri: string, parsed: URL): boolean {
  if (parsed.username || parsed.password) return true;
  const marker = uri.indexOf('://');
  if (marker === -1) return false;
  const afterMarker = uri.slice(marker + 3);
  const authorityEnd = afterMarker.search(/[/?#\\]/);
  return (authorityEnd === -1 ? afterMarker : afterMarker.slice(0, authorityEnd)).includes('@');
}

export interface RedirectUriPolicy {
  /**
   * Whether an application-specific scheme such as `com.example.app:/callback`
   * is acceptable. True for dynamic registration, where native clients rely on
   * one; false for metadata documents, which the MCP specification holds to
   * https or loopback.
   */
  allowPrivateUseSchemes: boolean;
}

/**
 * https anywhere, plain http only on this machine, and — where the policy
 * allows it — a private-use scheme for a native client.
 *
 * The point of refusing remote `http://` is that the code travels in the clear
 * on the final redirect: anyone on the path between the browser and the client
 * reads it, and a public client has nothing else to prove itself with.
 *
 * Every scheme is held to printable ASCII and refused with a userinfo part:
 * this is the address the login and consent pages show as the one thing "not
 * chosen by the application", so it must read as what it is.
 */
export function isSafeRedirectUri(uri: string, policy: RedirectUriPolicy): boolean {
  if (!PRINTABLE_ASCII_ONLY.test(uri)) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (hasUserinfo(uri, parsed)) return false;
  if (DANGEROUS_SCHEMES.has(parsed.protocol)) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return isLoopbackHostname(parsed.hostname);
  return policy.allowPrivateUseSchemes;
}

/**
 * Whether a requested redirect URI is covered by a registered one.
 *
 * RFC 8252 §7.3: an authorization server MUST allow any port on a loopback
 * redirect URI, because a native client is handed an ephemeral one by the
 * operating system and cannot register it in advance. Everything else is an
 * exact match — a prefix or origin comparison here is the classic open-redirect
 * hole.
 *
 * Lives here rather than being imported because SDK v2 dropped it: the helper
 * belonged to the authorization-server half, which the SDK no longer ships. It
 * is a dozen lines, and keeping the loopback set shared with the checks above
 * is worth more than the import was.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(req.hostname) || !isLoopbackHostname(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol && req.hostname === reg.hostname && req.pathname === reg.pathname && req.search === reg.search
  );
}

/**
 * True when every redirect URI points at this machine — the case the MCP
 * security considerations single out, because any local program could be the
 * one asking. Used to warn on the login and consent pages.
 */
export function isLoopbackOnly(redirectUris: string[] | undefined): boolean {
  if (!redirectUris?.length) return false;
  return redirectUris.every(uri => {
    try {
      return isLoopbackHostname(new URL(uri).hostname);
    } catch {
      return false;
    }
  });
}
