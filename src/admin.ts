#!/usr/bin/env node
import { AuthStore } from './auth/store.js';

function usage(): never {
  console.error('Usage: mcp-hub-admin clients list | clients revoke <client-id>');
  process.exit(2);
}

const [, , group, action, clientId] = process.argv;
if (group !== 'clients' || !['list', 'revoke'].includes(action ?? '')) usage();

const store = new AuthStore(process.env.DATA_PATH ?? '/data');

if (action === 'list') {
  const approvals = store.listApprovals();
  const rows = Object.entries(store.listClients()).map(([id, client]) => ({
    clientId: id,
    clientName: client.client_name ?? '',
    registeredRedirectUris: client.redirect_uris,
    approvedRedirectUris: approvals[id]?.redirectUris ?? [],
    approvedAt: approvals[id] ? new Date(approvals[id].approvedAt * 1000).toISOString() : null
  }));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (!clientId) usage();
const client = store.getClient(clientId);
if (!client) {
  console.error(`Unknown OAuth client: ${clientId}`);
  process.exit(1);
}
const result = store.revokeClientAccess(clientId);
console.log(
  JSON.stringify(
    {
      clientId,
      clientName: client.client_name ?? '',
      revokedRefreshTokens: result.refreshTokens,
      revokedAt: new Date(result.revokedBefore).toISOString()
    },
    null,
    2
  )
);
