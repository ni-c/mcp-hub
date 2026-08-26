import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Which addresses the hub refuses to make an outbound request to, and the
 * resolution step that decides it.
 *
 * Shared by the two places that fetch a URL somebody else chose: a client's
 * metadata document (inbound registration) and an upstream's authorization
 * server (outbound login). In both cases the URL, or a URL derived from a
 * document at that URL, is not the operator's.
 */

/** RFC 1918/4193/3927/6598 and friends: anything a public host could not
 *  legitimately be on, and that the hub can reach from inside. */
export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // protocol assignments, TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    return a >= 224; // multicast and reserved
  }
  if (version !== 6) return true; // not an address we resolved — refuse
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80') || normalized.startsWith('fec0')) return true;
  if (/^f[cd]/.test(normalized)) return true; // unique local
  // 6to4 and NAT64 carry an IPv4 address that the textual form hides, so the
  // ranges above would never see it — `64:ff9b::a9fe:a9fe` reaches the cloud
  // metadata endpoint. Both prefixes are refused whole: neither is a plausible
  // place for a public host.
  if (normalized.startsWith('2002:')) return true; // 6to4 (RFC 3056)
  if (normalized.startsWith('64:ff9b:')) return true; // NAT64 (RFC 6052)
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  return false;
}

/**
 * Resolves a hostname and refuses every private or loopback answer, returning
 * the address the connection must then be pinned to.
 *
 * Resolving here and letting `fetch` resolve again would leave the check and
 * the connection looking at two different answers — see pinned-fetch.ts.
 * Undefined means there is nothing to pin: a literal address cannot be
 * re-resolved, and the development escape hatch skips the check entirely.
 */
export async function resolvePublicAddress(hostname: string, allowPrivate = false): Promise<string | undefined> {
  if (allowPrivate) return undefined;
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) throw new Error(`${hostname} is a private address`);
    return undefined;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(`cannot resolve ${hostname}: ${(error as Error).message}`);
  }
  if (addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error(`${hostname} resolves to a private address`);
  }
  return addresses[0]?.address;
}
