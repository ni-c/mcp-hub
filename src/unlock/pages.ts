import { escapeHtml, renderPage } from '../auth/page.js';
import { escapeInvisibles } from '../auth/text.js';
import type { UnlockGrant } from '../auth/store.js';
import type { UnlockDuration } from './policy.js';
import type { UnlockRequest } from './runtime.js';

const esc = (value: string): string => escapeHtml(escapeInvisibles(value));

export const PAGE_STYLE = `<style>
  .card { width: min(30rem, 92vw); }
  .code { font-family: ui-monospace, monospace; font-size: 1.6rem; letter-spacing: 0.15em; color: var(--text); margin: 0 0 1rem; }
  .args { white-space: pre-wrap; max-height: 14rem; overflow: auto; }
  .row { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; border-top: 1px solid var(--line); padding: 0.6rem 0; }
  .row form { margin: 0; }
  .row button { width: auto; margin: 0; padding: 0.35rem 0.8rem; font-size: 0.85rem; }
  .ok { color: var(--text); }
  label { display: block; color: var(--muted); font-size: 0.75rem; margin: 0.9rem 0 0.35rem; }
</style>`;

export function durationLabel(duration: UnlockDuration): string {
  if (duration === 'once') return 'Only this call';
  if (duration < 60) return `${duration} minutes`;
  return duration === 60 ? '1 hour' : `${duration / 60} hours`;
}

export function untilLabel(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface FactorFields {
  askForCode: boolean;
}

function factorInputs({ askForCode }: FactorFields): string {
  return [
    '  <input type="password" name="password" placeholder="Password" required autocomplete="current-password">',
    askForCode
      ? '  <input type="text" name="code" placeholder="Code from your authenticator app" required autocomplete="one-time-code" inputmode="numeric" pattern="[0-9 ]*" maxlength="12">'
      : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function durationSelect(choices: readonly UnlockDuration[], selected: UnlockDuration | undefined): string {
  const options = choices.map(choice => `<option value="${choice}"${choice === selected ? ' selected' : ''}>${esc(durationLabel(choice))}</option>`).join('');
  return `<label for="duration">Unlock for</label>\n  <select id="duration" name="duration">${options}</select>`;
}

function page(title: string, body: string): string {
  return renderPage(title, `${PAGE_STYLE}\n<div class="card">\n${body}\n</div>`);
}

function clientLabel(request: Pick<UnlockRequest, 'clientId' | 'clientName'>): string {
  return request.clientName ? `${request.clientName} (${request.clientId})` : request.clientId;
}

export interface RequestPageInput {
  request: UnlockRequest;
  lockDescription: string;
  choices: readonly UnlockDuration[];
  selected: UnlockDuration | undefined;
  csrf: string;
  factors: FactorFields;
  error?: string;
}

/** Shows the hub's own record; the model's arguments sit outside the form. */
export function renderRequestPage({ request, lockDescription, choices, selected, csrf, factors, error }: RequestPageInput): string {
  const call = request.tool
    ? `  <p class="label">Call that asked (${request.argsComplete === false ? 'cut at 2 KiB, written by the model' : 'written by the model'})</p>
  <code class="target">${esc(request.tool)}</code>
  <code class="target args">${esc(request.args ?? '{}')}</code>`
    : '  <p class="label">Asked ahead of a call</p>';
  return page(
    'Unlock a server — mcp-hub',
    `  <h1>Unlock "${esc(request.server)}"?</h1>
  <p>A client asks to use a locked server. Unlock it only if you started this.</p>
  <p class="label">Matching code — compare it with the one in your chat</p>
  <p class="code">${esc(request.code)}</p>
  <p class="label">Client</p>
  <code class="target">${esc(clientLabel(request))}</code>
  <p class="label">Locked on this server</p>
  <code class="target">${esc(lockDescription)}</code>
  <p class="label">Asked at</p>
  <code class="target">${esc(untilLabel(request.createdAt))} through ${esc(request.door)}</code>
${call}
  <form method="post">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${durationSelect(choices, selected)}
${factorInputs(factors)}
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <button type="submit" name="action" value="unlock">Unlock</button>
  <button type="submit" name="action" value="deny" class="secondary" formnovalidate>Deny</button>
  </form>`
  );
}

export function renderOutcome(title: string, message: string, extra = ''): string {
  return page(`${title} — mcp-hub`, `  <h1>${esc(title)}</h1>\n  <p class="ok">${esc(message)}</p>\n${extra}`);
}

export function renderGrantList(grants: readonly (UnlockGrant & { id: string })[], ticket: string, names: (clientId: string) => string | undefined): string {
  if (grants.length === 0) return '  <p class="label">Nothing is unlocked right now.</p>';
  const rows = grants
    .map(grant => {
      const who = names(grant.clientId) ?? grant.clientId;
      const scope = grant.grantId === undefined ? 'every authorization' : 'one authorization';
      const what = grant.kind === 'once' ? `one call of ${grant.tool ?? '?'}` : `until ${untilLabel(grant.expiresAt)}`;
      return `  <div class="row"><span>${esc(grant.server)} · ${esc(who)} (${scope}) · ${esc(what)}</span>
  <form method="post" action="/unlock/lock"><input type="hidden" name="ticket" value="${esc(ticket)}"><input type="hidden" name="grant" value="${esc(grant.id)}"><button type="submit">Lock now</button></form></div>`;
    })
    .join('\n');
  return `  <p class="label">Unlocked now</p>\n${rows}`;
}

export function renderSignIn(factors: FactorFields, error?: string): string {
  return page(
    'Unlocks — mcp-hub',
    `  <h1>mcp-hub unlocks</h1>
  <p>Sign in to see open requests and what is unlocked.</p>
  <form method="post" action="/unlock">
${factorInputs(factors)}
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <button type="submit">Sign in</button>
  </form>`
  );
}

export interface DashboardInput {
  ticket: string;
  pending: readonly { request: UnlockRequest; choices: readonly UnlockDuration[]; selected: UnlockDuration | undefined }[];
  grants: readonly (UnlockGrant & { id: string })[];
  names: (clientId: string) => string | undefined;
  lockable: readonly { server: string; choices: readonly UnlockDuration[] }[];
  clients: readonly { clientId: string; name?: string }[];
  notice?: string;
}

export function renderDashboard({ ticket, pending, grants, names, lockable, clients, notice }: DashboardInput): string {
  const hidden = `<input type="hidden" name="ticket" value="${esc(ticket)}">`;
  const requests = pending.length
    ? pending
        .map(
          ({ request, choices, selected }) => `  <div class="row"><span><strong>${esc(request.code)}</strong> · ${esc(request.server)} · ${esc(clientLabel(request))}${request.tool ? ` · ${esc(request.tool)}` : ''}</span></div>
  ${request.tool ? `<code class="target args">${esc(request.args ?? '{}')}</code>` : ''}
  <form method="post" action="/unlock/decide">${hidden}<input type="hidden" name="request" value="${esc(request.id)}">
  ${durationSelect(choices, selected)}
  <button type="submit" name="action" value="unlock">Unlock</button>
  <button type="submit" name="action" value="deny" class="secondary">Deny</button></form>`
        )
        .join('\n')
    : '  <p class="label">No open requests.</p>';
  const servers = lockable.map(entry => `<option value="${esc(entry.server)}">${esc(entry.server)}</option>`).join('');
  const choices = [...new Set(lockable.flatMap(entry => entry.choices.filter(choice => choice !== 'once')))].toSorted((a, b) => Number(a) - Number(b));
  const clientOptions = clients.map(client => `<option value="${esc(client.clientId)}">${esc(client.name ? `${client.name} (${client.clientId})` : client.clientId)}</option>`).join('');
  const ahead =
    lockable.length && clients.length
      ? `  <p class="label">Unlock ahead of a call — for every authorization of the client</p>
  <form method="post" action="/unlock/grant">${hidden}
  <label for="server">Server</label><select id="server" name="server">${servers}</select>
  <label for="client">Client</label><select id="client" name="client">${clientOptions}</select>
  ${durationSelect(choices, choices.includes(30) ? 30 : choices[0])}
  <button type="submit">Unlock</button></form>`
      : '';
  return page(
    'Unlocks — mcp-hub',
    `  <h1>mcp-hub unlocks</h1>
  ${notice ? `<p class="ok">${esc(notice)}</p>` : '<p>This page stays usable for five minutes.</p>'}
  <p class="label">Open requests</p>
${requests}
${renderGrantList(grants, ticket, names)}
${ahead}`
  );
}
