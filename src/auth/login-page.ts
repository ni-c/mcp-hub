function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function renderLoginPage(requestToken: string, clientName?: string, errorMessage?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>mcp-hub login</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111826; color: #e5e7eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #1f2937; padding: 2rem; border-radius: 12px; width: min(20rem, 90vw); box-shadow: 0 8px 30px rgb(0 0 0 / 40%); }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  p { color: #9ca3af; font-size: 0.85rem; margin: 0 0 1.25rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 8px; border: 1px solid #374151; background: #111826; color: inherit; font-size: 1rem; }
  button { width: 100%; margin-top: 1rem; padding: 0.6rem; border: 0; border-radius: 8px; background: #6366f1; color: white; font-size: 1rem; cursor: pointer; }
  .error { color: #f87171; font-size: 0.85rem; margin: 0.75rem 0 0; }
</style>
</head>
<body>
<form method="post" action="login">
  <h1>mcp-hub</h1>
  <p>${clientName ? `Authorize <strong>${escapeHtml(clientName)}</strong>` : 'Authorization required'}</p>
  <input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
  <input type="hidden" name="request" value="${escapeHtml(requestToken)}">
  ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
