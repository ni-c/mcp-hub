import { escapeHtml, renderPage, renderIdentity } from './page.js';
import type { ClientIdentity } from './page.js';

/**
 * Entering the password here is what approves the client, so the page names
 * both the client and where its codes would be sent — the client name is
 * self-declared at registration and anyone can register, the URL cannot lie.
 */
export function renderLoginPage(requestToken: string, redirectUri: string, identity: ClientIdentity = {}, errorMessage?: string): string {
  return renderPage(
    'mcp-hub login',
    `<form method="post" action="login">
  <h1>mcp-hub</h1>
  <p>${identity.clientName ? `Authorize <strong>${escapeHtml(identity.clientName)}</strong>` : 'Authorization required'}</p>
${renderIdentity(redirectUri, identity)}
  <input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
  <input type="hidden" name="request" value="${escapeHtml(requestToken)}">
  ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
  <button type="submit">Sign in</button>
</form>`
  );
}
