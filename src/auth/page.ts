import { escapeInvisibles } from './text.js';

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
 *
 * Each field also goes through `escapeInvisibles`: registration refuses bidi
 * and zero-width characters now, but a client stored before that must not be
 * able to reorder the line the operator judges it by. (`clientName` is
 * cleaned by `clampDisplayName` before it gets here.)
 */
export function renderIdentity(redirectUri: string, identity: ClientIdentity): string {
  const lines = [
    '  <p class="label">Requested access</p>',
    `  <code class="target">${escapeHtml(escapeInvisibles(identity.resource ?? 'Every server on this hub'))}</code>`
  ];
  if (identity.clientId) {
    lines.push('  <p class="label">Identified by</p>', `  <code class="target">${escapeHtml(escapeInvisibles(identity.clientId))}</code>`);
  }
  lines.push('  <p class="label">Codes will be sent to</p>', `  <code class="target">${escapeHtml(escapeInvisibles(redirectUri))}</code>`);
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
  :root { color-scheme: light dark; --bg: #111826; --card: #1f2937; --text: #e5e7eb; --muted: #9ca3af; --line: #374151; --field: #111826; --accent: #6366f1; --error: #f87171; --shadow: rgb(0 0 0 / 40%); }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f3f4f6; --card: #ffffff; --text: #111827; --muted: #4b5563; --line: #d1d5db; --field: #f9fafb; --error: #b91c1c; --shadow: rgb(15 23 42 / 12%); }
  }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  body > form, .card { background: var(--card); padding: 2rem; border-radius: 12px; width: min(22rem, 90vw); box-shadow: 0 8px 30px var(--shadow); }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  p { color: var(--muted); font-size: 0.85rem; margin: 0 0 1.25rem; }
  input[type=password], input[type=text], select { width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 8px; border: 1px solid var(--line); background: var(--field); color: inherit; font-size: 1rem; }
  input + input, input + select, select + input { margin-top: 0.75rem; }
  button { width: 100%; margin-top: 1rem; padding: 0.6rem; border: 0; border-radius: 8px; background: var(--accent); color: white; font-size: 1rem; cursor: pointer; }
  button.secondary { background: transparent; border: 1px solid var(--line); color: var(--muted); margin-top: 0.5rem; }
  .target { display: block; margin: 0 0 1.25rem; padding: 0.6rem; border-radius: 8px; background: var(--field); border: 1px solid var(--line); font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--text); overflow-wrap: anywhere; }
  .label { color: var(--muted); font-size: 0.75rem; margin: 0 0 0.35rem; }
  .error { color: var(--error); font-size: 0.85rem; margin: 0.75rem 0 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
