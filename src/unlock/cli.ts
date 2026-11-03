import type { HubConfig } from '../config.js';
import type { AuthStore, UnlockGrant } from '../auth/store.js';

/** What `mcp-hub-admin unlock grant` would store, or why it will not. */
export function planGrant(input: { config: HubConfig; store: AuthStore; server: string | undefined; minutes: string | undefined; clientId: string | undefined; now?: number }): UnlockGrant | string {
  const { config, store, server, minutes, clientId } = input;
  if (!server || !minutes || !clientId) return 'Usage: mcp-hub-admin unlock grant <server> <minutes> --client <client-id>';
  const policy = config.get(server)?.unlock;
  if (!policy) return `Server "${server}" ${config.has(server) ? 'is not locked' : 'is not configured'} — only servers with "unlock" in mcp.json can be unlocked.`;
  const value = /^\d{1,4}$/.test(minutes) ? Number(minutes) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > policy.maxMinutes) {
    return policy.maxMinutes === 0
      ? `Server "${server}" allows single calls only; approve them on the unlock page.`
      : `Minutes must be a whole number from 1 to ${policy.maxMinutes}, the cap of "${server}".`;
  }
  const known = clientId.startsWith('token:') ? store.getApiToken(clientId.slice('token:'.length)) !== undefined : store.getApproval(clientId) !== undefined;
  if (!known) return `No approved client or API token "${clientId}". mcp-hub-admin clients list and tokens list show them.`;
  const now = input.now ?? Date.now();
  return { server, clientId, kind: 'window', grantedAt: now, expiresAt: now + value * 60_000, by: 'cli' };
}
