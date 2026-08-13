import { escapeHtml, renderPage } from './page.js';

/**
 * Entering the password here is what approves the client, so the page names
 * both the client and where its codes would be sent — the client name is
 * self-declared at registration and anyone can register, the URL cannot lie.
 */
export function renderLoginPage(requestToken: string, redirectUri: string, clientName?: string, errorMessage?: string, resource?: string): string {
  return renderPage(
    'mcp-hub login',
    `<form method="post" action="login">
  <h1>mcp-hub</h1>
  <p>${clientName ? `Authorize <strong>${escapeHtml(clientName)}</strong>` : 'Authorization required'}</p>
  <p class="label">Requested access</p>
  <code class="target">${escapeHtml(resource ?? 'Every server on this hub')}</code>
  <p class="label">Codes will be sent to</p>
  <code class="target">${escapeHtml(redirectUri)}</code>
  <input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
  <input type="hidden" name="request" value="${escapeHtml(requestToken)}">
  ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
  <button type="submit">Sign in</button>
</form>`
  );
}
