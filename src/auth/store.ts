import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // epoch seconds
  familyId?: string; // absent on tokens issued before rotation tracking existed
  resource?: string; // canonical RFC 8707 resource; absent on legacy global tokens
}

/** One recorded "yes, this client may have codes" decision. */
export interface ClientApproval {
  redirectUris: string[];
  clientName?: string;
  approvedAt: number; // epoch seconds
}

interface ConsumedRefreshToken {
  familyId: string;
  expiresAt: number; // epoch seconds
}

interface PersistedState {
  cookieSecret: string;
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshTokenRecord>; // keyed by sha256(token)
  approvals: Record<string, ClientApproval>; // keyed by client_id
  consumedRefreshTokens: Record<string, ConsumedRefreshToken>; // keyed by sha256(token)
  revokedBefore: Record<string, number>; // client_id -> epoch milliseconds
}

/**
 * Registration is open (anyone can POST /register), so unconfirmed clients
 * would otherwise accumulate on disk without bound and every registration
 * rewrites state.json whole. Cap the number of clients that were never
 * approved; approved ones are legitimate and never evicted.
 */
export const MAX_UNAPPROVED_CLIENTS = 100;

/**
 * All persistent auth state lives in two files under DATA_PATH:
 * jwt-key.pem (Ed25519 private key) and state.json (clients, refresh tokens,
 * cookie secret). Losing either invalidates every connector authorization —
 * the volume must survive container recreates.
 */
export class AuthStore {
  readonly privateKey: crypto.KeyObject;
  readonly publicKey: crypto.KeyObject;
  private state: PersistedState;
  private readonly statePath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const keyPath = path.join(dataDir, 'jwt-key.pem');
    if (!fs.existsSync(keyPath)) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    this.privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    this.publicKey = crypto.createPublicKey(this.privateKey);

    this.statePath = path.join(dataDir, 'state.json');
    const restored = AuthStore.readState(this.statePath);
    this.state = restored ?? {
      cookieSecret: crypto.randomBytes(32).toString('base64url'),
      clients: {},
      refreshTokens: {},
      approvals: {},
      consumedRefreshTokens: {},
      revokedBefore: {}
    };
    if (!restored) this.persist();
  }

  /**
   * Undefined when there is nothing usable to restore. A corrupt file is moved
   * aside rather than overwritten so it can still be salvaged by hand — the
   * hub boots with fresh state and every connector has to authorize again,
   * which beats refusing to start at all.
   */
  private static readState(statePath: string): PersistedState | undefined {
    if (!fs.existsSync(statePath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PersistedState | null;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.cookieSecret !== 'string') {
        throw new Error('no usable cookieSecret');
      }
      // Fields added later default to empty: a state.json written before
      // client approvals existed leaves every client unapproved, so each one
      // has to be confirmed once instead of being trusted silently.
      return {
        cookieSecret: parsed.cookieSecret,
        clients: parsed.clients ?? {},
        refreshTokens: parsed.refreshTokens ?? {},
        approvals: parsed.approvals ?? {},
        consumedRefreshTokens: parsed.consumedRefreshTokens ?? {},
        revokedBefore: parsed.revokedBefore ?? {}
      };
    } catch (error) {
      const backup = `${statePath}.corrupt-${Date.now()}`;
      fs.renameSync(statePath, backup);
      console.error(
        `mcp-hub: unusable auth state (${(error as Error).message}), moved to ${backup}; all connectors must authorize again`
      );
      return undefined;
    }
  }

  private persist(): void {
    this.pruneExpired();
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }

  private pruneExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
      if (record.expiresAt < now) delete this.state.refreshTokens[hash];
    }
    for (const [hash, record] of Object.entries(this.state.consumedRefreshTokens)) {
      if (record.expiresAt < now) delete this.state.consumedRefreshTokens[hash];
    }
  }

  get cookieSecret(): string {
    return this.state.cookieSecret;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  listClients(): Record<string, OAuthClientInformationFull> {
    return structuredClone(this.state.clients);
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.state.clients[client.client_id] = client;
    this.pruneUnapprovedClients();
    this.persist();
  }

  /**
   * Evict the oldest never-approved clients once too many pile up. A client
   * with an approval entry is one the operator confirmed and is kept; the just
   * -registered client is the newest and therefore survives its own eviction.
   */
  private pruneUnapprovedClients(): void {
    const unapproved = Object.values(this.state.clients)
      .filter(c => !this.state.approvals[c.client_id])
      .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
    for (let i = 0; i < unapproved.length - MAX_UNAPPROVED_CLIENTS; i++) {
      delete this.state.clients[unapproved[i].client_id];
    }
  }

  getApproval(clientId: string): ClientApproval | undefined {
    return this.state.approvals[clientId];
  }

  /** Records consent for one client; a client may legitimately use several
   *  redirect URIs, so they accumulate rather than replace each other. */
  saveApproval(clientId: string, redirectUri: string, clientName?: string): void {
    const existing = this.state.approvals[clientId];
    const redirectUris = existing ? [...new Set([...existing.redirectUris, redirectUri])] : [redirectUri];
    this.state.approvals[clientId] = {
      redirectUris,
      clientName: clientName ?? existing?.clientName,
      approvedAt: existing?.approvedAt ?? Math.floor(Date.now() / 1000)
    };
    this.persist();
  }

  listApprovals(): Record<string, ClientApproval> {
    return structuredClone(this.state.approvals);
  }

  revokeApproval(clientId: string): void {
    this.revokeClientAccess(clientId);
  }

  getRevokedBefore(clientId: string): number | undefined {
    return this.state.revokedBefore[clientId];
  }

  /**
   * Immediately withdraw every grant for one client. Access JWTs are rejected
   * using revokedBefore, while every active refresh token is removed from
   * disk. The client registration stays so it can go through consent again.
   */
  revokeClientAccess(clientId: string): { refreshTokens: number; revokedBefore: number } {
    delete this.state.approvals[clientId];
    let refreshTokens = 0;
    for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
      if (record.clientId === clientId) {
        delete this.state.refreshTokens[hash];
        refreshTokens++;
      }
    }
    const revokedBefore = Date.now();
    this.state.revokedBefore[clientId] = revokedBefore;
    this.persist();
    return { refreshTokens, revokedBefore };
  }

  private static hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  saveRefreshToken(token: string, record: RefreshTokenRecord): void {
    this.state.refreshTokens[AuthStore.hash(token)] = record;
    this.persist();
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    const record = this.state.refreshTokens[AuthStore.hash(token)];
    if (record && record.expiresAt < Math.floor(Date.now() / 1000)) return undefined;
    return record;
  }

  deleteRefreshToken(token: string): void {
    delete this.state.refreshTokens[AuthStore.hash(token)];
    this.persist();
  }

  /**
   * Rotation step: the token is invalidated but remembered, so that a replay
   * of an already-rotated token can be told apart from a merely unknown one.
   */
  consumeRefreshToken(token: string, familyId: string, expiresAt: number): void {
    delete this.state.refreshTokens[AuthStore.hash(token)];
    this.state.consumedRefreshTokens[AuthStore.hash(token)] = { familyId, expiresAt };
    this.persist();
  }

  wasConsumed(token: string): ConsumedRefreshToken | undefined {
    return this.state.consumedRefreshTokens[AuthStore.hash(token)];
  }

  /** A replayed refresh token means the chain leaked; drop every token of it. */
  revokeFamily(familyId: string): number {
    let revoked = 0;
    for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
      if (record.familyId === familyId) {
        delete this.state.refreshTokens[hash];
        revoked++;
      }
    }
    this.persist();
    return revoked;
  }
}
