import { renderUnicodeCompact } from 'uqr';

import { appleOtpauthUri, generateTotpSecret, otpauthUri } from './totp.js';

export interface TotpSetup {
  secret: string;
  /** The secret in groups of four, the way authenticator apps ask for it. */
  setupKey: string;
  uri: string;
  appleUri: string;
  /** Light modules as blocks, for a dark terminal; `lightTerminal` swaps them. */
  qr: string;
}

export function prepareTotpSetup(account: string, options: { secret?: string; lightTerminal?: boolean } = {}): TotpSetup {
  const secret = options.secret ?? generateTotpSecret();
  const uri = otpauthUri(secret, account);
  return {
    secret,
    setupKey: (secret.match(/.{1,4}/g) ?? []).join(' '),
    uri,
    appleUri: appleOtpauthUri(secret, account),
    qr: renderUnicodeCompact(uri, { border: 2, invert: options.lightTerminal ?? false })
  };
}

/** The name an authenticator lists the hub under: the host of EXTERNAL_URL when there is one. */
export function totpAccountLabel(externalUrl: string | undefined): string {
  if (!externalUrl) return 'mcp-hub';
  try {
    return new URL(externalUrl).host || 'mcp-hub';
  } catch {
    return 'mcp-hub';
  }
}
