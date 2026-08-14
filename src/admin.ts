#!/usr/bin/env node
import { AuthStore } from './auth/store.js';
import { mintApiToken } from './auth/provider.js';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  mcp-hub-admin clients list',
      '  mcp-hub-admin clients revoke <client-id>',
      '  mcp-hub-admin tokens create --resource <name|hub> [--days <n>] [--label <text>]',
      '  mcp-hub-admin tokens list',
      '  mcp-hub-admin tokens revoke <token-id>',
      '',
      'tokens create needs EXTERNAL_URL in the environment (same value the hub runs with).'
    ].join('\n')
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`Missing value for --${name}`);
    process.exit(2);
  }
  return value;
}

const [, , group, action, ...rest] = process.argv;
const store = new AuthStore(process.env.DATA_PATH ?? '/data');

if (group === 'clients' && action === 'list') {
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

if (group === 'clients' && action === 'revoke') {
  const clientId = rest[0];
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
  process.exit(0);
}

if (group === 'tokens' && action === 'create') {
  const externalUrl = process.env.EXTERNAL_URL;
  if (!externalUrl) {
    console.error('tokens create requires EXTERNAL_URL (the public origin the hub runs under)');
    process.exit(1);
  }
  const name = flag(rest, 'resource');
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error('tokens create requires --resource <server-name|hub>');
    process.exit(2);
  }
  const days = Number(flag(rest, 'days') ?? '90');
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    console.error('--days must be an integer between 1 and 3650');
    process.exit(2);
  }
  const label = flag(rest, 'label') ?? name;
  // The resource URL is derived, not validated against mcp.json — the admin
  // container runs without the config mounted. A token for a name that never
  // becomes a server simply fails verification at use.
  const origin = new URL(externalUrl).origin;
  const resource = new URL(name === 'hub' ? '/hub' : `/${name}/mcp`, origin);
  const { id, token, expiresAt } = await mintApiToken(store, externalUrl, resource, days, label);
  console.error(`API token created. This is the only time the token itself is shown:`);
  console.log(token);
  console.error(JSON.stringify({ id, label, resource: resource.href, expiresAt: new Date(expiresAt * 1000).toISOString() }, null, 2));
  process.exit(0);
}

if (group === 'tokens' && action === 'list') {
  const rows = Object.entries(store.listApiTokens()).map(([id, record]) => ({
    id,
    label: record.label,
    resource: record.resource,
    createdAt: new Date(record.createdAt * 1000).toISOString(),
    expiresAt: new Date(record.expiresAt * 1000).toISOString()
  }));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (group === 'tokens' && action === 'revoke') {
  const id = rest[0];
  if (!id) usage();
  if (!store.revokeApiToken(id)) {
    console.error(`Unknown API token: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ id, revoked: true }, null, 2));
  process.exit(0);
}

usage();
