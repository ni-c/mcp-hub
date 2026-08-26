export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/** What the login and consent pages say about the client that is asking. */
export interface ClientIdentity {
  clientName?: string;
  /** Canonical resource the token would be bound to. */
  resource?: string;
  /** The Client ID Metadata Document URL, for clients that have one. */
  clientId?: string;
  /** Every redirect URI points at this machine. */
  loopbackOnly?: boolean;
}

/**
 * The block both pages share: what access is requested, where codes would go
 * and — for a Client ID Metadata Document client — the URL that vouches for
 * the name above it. The document URL is the one part of a CIMD client's
 * identity that cannot be invented, which is why the specification asks for it
 * to be shown; a client whose redirect URIs are all local cannot be attributed
 * to anything at all, so that gets said outright.
 */
export function renderIdentity(redirectUri: string, identity: ClientIdentity): string {
  const lines = [
    '  <p class="label">Requested access</p>',
    `  <code class="target">${escapeHtml(identity.resource ?? 'Every server on this hub')}</code>`
  ];
  if (identity.clientId) {
    lines.push('  <p class="label">Identified by</p>', `  <code class="target">${escapeHtml(identity.clientId)}</code>`);
  }
  lines.push('  <p class="label">Codes will be sent to</p>', `  <code class="target">${escapeHtml(redirectUri)}</code>`);
  if (identity.loopbackOnly) {
    lines.push('  <p class="error">This client only accepts codes on this machine, so any program running here could be the one asking.</p>');
  }
  return lines.join('\n');
}

/** Shared chrome for the two interactive pages, login and consent. */
export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111826; color: #e5e7eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #1f2937; padding: 2rem; border-radius: 12px; width: min(22rem, 90vw); box-shadow: 0 8px 30px rgb(0 0 0 / 40%); }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  p { color: #9ca3af; font-size: 0.85rem; margin: 0 0 1.25rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 8px; border: 1px solid #374151; background: #111826; color: inherit; font-size: 1rem; }
  button { width: 100%; margin-top: 1rem; padding: 0.6rem; border: 0; border-radius: 8px; background: #6366f1; color: white; font-size: 1rem; cursor: pointer; }
  button.secondary { background: transparent; border: 1px solid #374151; color: #9ca3af; margin-top: 0.5rem; }
  .target { display: block; margin: 0 0 1.25rem; padding: 0.6rem; border-radius: 8px; background: #111826; border: 1px solid #374151; font-family: ui-monospace, monospace; font-size: 0.8rem; color: #e5e7eb; overflow-wrap: anywhere; }
  .label { color: #9ca3af; font-size: 0.75rem; margin: 0 0 0.35rem; }
  .error { color: #f87171; font-size: 0.85rem; margin: 0.75rem 0 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
