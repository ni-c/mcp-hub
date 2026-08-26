#!/usr/bin/env node
import crypto from 'node:crypto';
import { AuthStore, clientLimitsFromEnv } from './auth/store.js';
import { isSafeRedirectUri } from './auth/redirect-uri.js';
import { clampDisplayName } from './auth/text.js';
import { isClientIdMetadataUrl } from './auth/cimd.js';
import { mintApiToken } from './auth/provider.js';
import { loadConfig } from './config.js';
import type { UpstreamAuth } from './upstream/auth.js';
import { authFor, requireOAuthServer, startUpstreamLogin, upstreamStatus } from './upstream/login.js';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  mcp-hub-admin clients list',
      '  mcp-hub-admin clients add --name <text> --redirect-uri <uri> [--public]',
      '  mcp-hub-admin clients revoke <client-id>   (withdraws access, keeps the registration)',
      '  mcp-hub-admin clients delete <client-id>   (removes the registration outright)',
      '  mcp-hub-admin clients prune [--dry-run]',
      '  mcp-hub-admin tokens create --resource <name|hub> [--days <n>] [--label <text>]',
      '  mcp-hub-admin tokens list',
      '  mcp-hub-admin tokens revoke <token-id>',
      '  mcp-hub-admin upstream list',
      '  mcp-hub-admin upstream status <server>',
      '  mcp-hub-admin upstream login <server> [--no-wait]',
      '  mcp-hub-admin upstream register <server>   (obtain a client_id without logging in)',
      '  mcp-hub-admin upstream refresh <server>    (renew the token now)',
      '  mcp-hub-admin upstream logout <server>     (forget it here and revoke it there)',
      '',
      'tokens create needs EXTERNAL_URL in the environment (same value the hub runs with).',
      'upstream commands read CONFIG_PATH; run them inside the hub container so the',
      'same mcp.json and the same ${VAR} values are in scope.'
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

/** How this client came to exist, for `clients list`. */
function clientOrigin(clientId: string): 'cimd' | 'static' | 'dcr' {
  if (isClientIdMetadataUrl(clientId)) return 'cimd';
  return store.isOperatorManaged(clientId) ? 'static' : 'dcr';
}

const [, , group, action, ...rest] = process.argv;
// The same limits the hub runs with, so a prune here removes exactly what the
// hub would. `docker exec` into the hub container shares its environment.
const store = new AuthStore(process.env.DATA_PATH ?? '/data', clientLimitsFromEnv());

if (group === 'clients' && action === 'list') {
  const approvals = store.listApprovals();
  const clients = store.listClients();
  const rows = Object.entries(clients).map(([id, client]) => ({
    clientId: id,
    clientName: client.client_name ?? '',
    via: clientOrigin(id),
    registeredRedirectUris: client.redirect_uris,
    approvedRedirectUris: approvals[id]?.redirectUris ?? [],
    approvedAt: approvals[id] ? new Date(approvals[id].approvedAt * 1000).toISOString() : null
  }));
  // Metadata-document clients are never stored — the document is fetched fresh
  // on every authorization — so an approval is the only trace they leave. They
  // would otherwise be a blind spot in the one command that answers "who can
  // reach this hub", even though `clients revoke` works on them fine.
  for (const [id, approval] of Object.entries(approvals)) {
    if (clients[id]) continue;
    rows.push({
      clientId: id,
      clientName: approval.clientName ?? '',
      via: clientOrigin(id),
      registeredRedirectUris: [],
      approvedRedirectUris: approval.redirectUris,
      approvedAt: new Date(approval.approvedAt * 1000).toISOString()
    });
  }
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (group === 'clients' && action === 'add') {
  const name = flag(rest, 'name');
  const redirectUri = flag(rest, 'redirect-uri');
  if (!name || !redirectUri) usage();
  if (!isSafeRedirectUri(redirectUri, { allowPrivateUseSchemes: true })) {
    console.error(`redirect-uri must be https, a loopback address or a private-use scheme: ${redirectUri}`);
    process.exit(2);
  }
  const isPublic = rest.includes('--public');
  const clientId = crypto.randomBytes(16).toString('base64url');
  const clientSecret = isPublic ? undefined : crypto.randomBytes(32).toString('hex');
  const stored = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clampDisplayName(name),
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {})
  };
  // operatorManaged: exempt from the ceiling and from every expiry rule. A
  // client somebody typed out by hand must not vanish after ninety idle days.
  store.addClient(stored, undefined, { operatorManaged: true });
  // Creating it *is* the approval: the operator named the redirect URI, so
  // sending them through a browser to confirm what they just typed is noise.
  store.saveApproval(clientId, redirectUri, stored.client_name);
  console.error('OAuth client created. This is the only time the secret is shown:');
  console.log(JSON.stringify({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }, null, 2));
  console.error(
    JSON.stringify({ clientName: stored.client_name, redirectUri, public: isPublic, approved: true }, null, 2)
  );
  process.exit(0);
}

if (group === 'clients' && action === 'revoke') {
  const clientId = rest[0];
  if (!clientId) usage();
  // A metadata-document client has no stored registration, so its approval is
  // what proves it was ever let in.
  const client = store.getClient(clientId);
  const approval = store.getApproval(clientId);
  if (!client && !approval) {
    console.error(`Unknown OAuth client: ${clientId}`);
    process.exit(1);
  }
  const result = store.revokeClientAccess(clientId);
  console.log(
    JSON.stringify(
      {
        clientId,
        clientName: client?.client_name ?? approval?.clientName ?? '',
        revokedRefreshTokens: result.refreshTokens,
        revokedAt: new Date(result.revokedBefore).toISOString()
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (group === 'clients' && action === 'delete') {
  const clientId = rest[0];
  if (!clientId) usage();
  const client = store.getClient(clientId);
  const approval = store.getApproval(clientId);
  if (!client && !approval) {
    console.error(`Unknown OAuth client: ${clientId}`);
    process.exit(1);
  }
  // Unlike revoke, this leaves nothing behind: the client would have to
  // register again from scratch.
  store.deleteClient(clientId);
  console.log(JSON.stringify({ clientId, clientName: client?.client_name ?? approval?.clientName ?? '', deleted: true }, null, 2));
  process.exit(0);
}

if (group === 'clients' && action === 'prune') {
  const dryRun = rest.includes('--dry-run');
  const limits = store.clientLimits;
  const describe = (ids: string[]) =>
    ids.map(id => ({ clientId: id, clientName: store.getClient(id)?.client_name ?? '' }));
  // Read the plan before acting so a dry run and a real run report the same
  // shape, and so the names are still resolvable.
  const planned = store.planClientPrune();
  const report = {
    dryRun,
    limits: {
      maxClients: limits.maxClients,
      pendingTtlHours: limits.pendingTtlSeconds / 3600,
      inactiveDays: limits.inactiveSeconds / 86_400
    },
    neverApproved: describe(planned.pending),
    unused: describe(planned.inactive)
  };
  if (!dryRun) store.pruneClients();
  console.log(JSON.stringify(report, null, 2));
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

if (group === 'upstream') {
  const configPath = process.env.CONFIG_PATH ?? '/config/mcp.json';
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error(`Cannot read ${configPath}: ${(error as Error).message}`);
    process.exit(1);
  }
  // The image sets CONFIG_PATH and DATA_PATH but never EXTERNAL_URL, so the
  // value the hub recorded at boot is normally the one that applies.
  const externalUrl = process.env.EXTERNAL_URL ?? store.getExternalUrl();
  const name = rest.find(argument => !argument.startsWith('--'));

  const fail: (message: string) => never = message => {
    console.error(message);
    process.exit(2);
  };

  if (action === 'list' || action === 'status') {
    try {
      console.log(JSON.stringify(upstreamStatus(store, config, action === 'status' ? name : undefined), null, 2));
    } catch (error) {
      fail((error as Error).message);
    }
    process.exit(0);
  }

  if (!name) usage();
  if (!externalUrl) {
    console.error('upstream commands need EXTERNAL_URL (the origin the hub runs under), or a hub that has run at least once');
    process.exit(1);
  }
  let auth: UpstreamAuth;
  try {
    auth = authFor(store, new URL(externalUrl).href, name, requireOAuthServer(config, name));
  } catch (error) {
    fail((error as Error).message);
  }

  if (action === 'login') {
    let started: { authorizationUrl: string; expiresAt: number };
    try {
      started = await startUpstreamLogin(store, auth);
    } catch (error) {
      fail((error as Error).message);
    }
    console.error('Open this in a browser that is signed in to the hub:');
    console.log(started.authorizationUrl);
    if (rest.includes('--no-wait')) process.exit(0);
    console.error('Waiting for the upstream to redirect back…');
    // The callback lands on the hub, in another process, and writes the tokens
    // to the same state file. Each poll is a stat, so this stays cheap.
    const before = store.getUpstreamCredentials(name, auth.fingerprint)?.obtainedAt ?? 0;
    for (;;) {
      const record = store.getUpstreamCredentials(name, auth.fingerprint);
      if (record?.tokens && record.obtainedAt >= before) {
        console.log(JSON.stringify({ server: name, authorized: true }, null, 2));
        process.exit(0);
      }
      if (Date.now() > started.expiresAt) {
        console.error('The login was not completed in time. Run it again.');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }

  if (action === 'register') {
    try {
      const discovery = await auth.discover(true);
      const information = await auth.clientInformation(discovery);
      console.log(JSON.stringify({ server: name, clientId: information.client_id }, null, 2));
    } catch (error) {
      fail((error as Error).message);
    }
    process.exit(0);
  }

  if (action === 'refresh') {
    try {
      await auth.prepare({ force: true });
    } catch (error) {
      fail((error as Error).message);
    }
    const record = store.getUpstreamCredentials(name, auth.fingerprint);
    console.log(
      JSON.stringify(
        {
          server: name,
          refreshed: true,
          ...(record?.accessTokenValidUntil ? { accessTokenValidUntil: new Date(record.accessTokenValidUntil * 1000).toISOString() } : {})
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (action === 'logout') {
    // Best effort at the upstream, unconditional locally: a third party being
    // unreachable must never leave a credential behind here.
    const problems = await auth.revokeRemotely().catch(error => [(error as Error).message]);
    const forgotten = store.forgetUpstreamCredentials(name);
    for (const problem of problems) console.error(`Upstream revocation: ${problem}`);
    console.log(JSON.stringify({ server: name, forgotten, revokedAtUpstream: problems.length === 0 }, null, 2));
    process.exit(problems.length > 0 ? 1 : 0);
  }

  usage();
}

usage();
