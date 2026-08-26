import { escapeHtml, renderPage, renderIdentity } from './page.js';
import type { ClientIdentity } from './page.js';

/**
 * Shown when a signed-in user is asked to authorize a client they have not
 * confirmed before. This is the only thing standing between a live session
 * cookie and a code, so it must never be submitted on the user's behalf:
 * the CSRF token ties the form to their session.
 */
export function renderConsentPage(requestToken: string, csrfToken: string, redirectUri: string, identity: ClientIdentity = {}): string {
  return renderPage(
    'mcp-hub authorization',
    `<form method="post" action="consent">
  <h1>Authorize access?</h1>
  <p>${identity.clientName ? `<strong>${escapeHtml(identity.clientName)}</strong> is asking` : 'An application is asking'} for access.</p>
${renderIdentity(redirectUri, identity)}
  <p>Only continue if you started this yourself. The name above is chosen by the application; the address is not.</p>
  <input type="hidden" name="request" value="${escapeHtml(requestToken)}">
  <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
  <button type="submit" name="action" value="approve">Approve</button>
  <button type="submit" name="action" value="deny" class="secondary">Deny</button>
</form>`
  );
}
