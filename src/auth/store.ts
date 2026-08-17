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

/**
 * A long-lived API token minted by the admin CLI for clients that cannot do
 * OAuth (OpenAI Responses API, xAI API, Gemini API, header-only clients). The
 * JWT itself is never stored — this record is what makes it listable and
 * revocable; verification refuses a jti with no live record.
 */
export interface ApiTokenRecord {
  label: string;
  resource: string; // canonical resource URL the token is bound to
  createdAt: number; // epoch seconds
  expiresAt: number; // epoch seconds
}

interface PersistedState {
  cookieSecret: string;
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshTokenRecord>; // keyed by sha256(token)
  approvals: Record<string, ClientApproval>; // keyed by client_id
  consumedRefreshTokens: Record<string, ConsumedRefreshToken>; // keyed by sha256(token)
  revokedBefore: Record<string, number>; // client_id -> epoch milliseconds
  apiTokens: Record<string, ApiTokenRecord>; // keyed by token id (jti)
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
 *
 * state.json has more than one writer: the long-running hub and every
 * `mcp-hub-admin` invocation, which is a separate process against the same
 * volume. Because persist() rewrites the whole file, a store that trusted its
 * in-memory copy would (a) not see a token minted elsewhere, (b) keep honouring
 * a token revoked elsewhere, and (c) write its stale copy back on the next
 * unrelated save, resurrecting what was revoked. Every read therefore checks
 * whether the file changed underneath it, and every mutation is a
 * read-modify-write.
 */
export class AuthStore {
  readonly privateKey: crypto.KeyObject;
  readonly publicKey: crypto.KeyObject;
  private state: PersistedState;
  private readonly statePath: string;
  /** Identity of the file contents this.state was loaded from; see fileSignature(). */
  private signature?: string;
  private tmpCounter = 0;

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
      revokedBefore: {},
      apiTokens: {}
    };
    if (restored) this.signature = this.fileSignature();
    else this.persist();
  }

  /**
   * Inode, mtime and size of state.json, or undefined when it is gone. The
   * inode carries the weight: persist() publishes by rename, so any write by
   * another process produces a different one. mtime and size only guard the
   * case of an inode number reused for a same-sized file in the same
   * millisecond.
   */
  private fileSignature(): string | undefined {
    try {
      const s = fs.statSync(this.statePath);
      return `${s.ino}:${s.mtimeMs}:${s.size}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-reads state.json when another process has replaced it. Deliberately
   * gentler than the constructor: a file that cannot be parsed leaves the
   * in-memory state alone instead of being quarantined and replaced by a fresh
   * one. Rotating cookieSecret under a running hub would log out every session
   * and force every connector to authorize again — far worse than carrying on
   * with the state we already hold.
   */
  private reloadIfChanged(): void {
    const signature = this.fileSignature();
    if (signature === undefined || signature === this.signature) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      console.error(`mcp-hub: could not re-read auth state, keeping the state in memory: ${(error as Error).message}`);
      return;
    }
    const next = AuthStore.normalize(parsed);
    if (!next) {
      console.error('mcp-hub: auth state changed on disk but is unusable, keeping the state in memory');
      return;
    }
    this.state = next;
    this.signature = signature;
  }

  /**
   * Read-modify-write. Picking up another process's changes before mutating is
   * what stops persist() from writing a stale snapshot back over them.
   */
  private mutate<T>(fn: () => T): T {
    this.reloadIfChanged();
    const result = fn();
    this.persist();
    return result;
  }

  /**
   * Shapes a parsed state file, or undefined when it is unusable. Fields added
   * later default to empty: a state.json written before client approvals
   * existed leaves every client unapproved, so each one has to be confirmed
   * once instead of being trusted silently.
   */
  private static normalize(parsed: unknown): PersistedState | undefined {
    const state = parsed as PersistedState | null;
    if (!state || typeof state !== 'object' || typeof state.cookieSecret !== 'string') return undefined;
    return {
      cookieSecret: state.cookieSecret,
      clients: state.clients ?? {},
      refreshTokens: state.refreshTokens ?? {},
      approvals: state.approvals ?? {},
      consumedRefreshTokens: state.consumedRefreshTokens ?? {},
      revokedBefore: state.revokedBefore ?? {},
      apiTokens: state.apiTokens ?? {}
    };
  }

  /**
   * Undefined when there is nothing usable to restore. A corrupt file is moved
   * aside rather than overwritten so it can still be salvaged by hand — the
   * hub boots with fresh state and every connector has to authorize again,
   * which beats refusing to start at all. Only the constructor does this;
   * reloadIfChanged() never discards live state.
   */
  private static readState(statePath: string): PersistedState | undefined {
    if (!fs.existsSync(statePath)) return undefined;
    try {
      const normalized = AuthStore.normalize(JSON.parse(fs.readFileSync(statePath, 'utf8')));
      if (!normalized) throw new Error('no usable cookieSecret');
      return normalized;
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
    // Per-writer temporary name: a fixed one would let two processes write into
    // the same file at once. With a private temporary plus an atomic rename a
    // reader can never observe a half-written file — the residual risk of
    // concurrent writers is a lost update, not a corrupt state.
    const tmp = `${this.statePath}.tmp-${process.pid}-${this.tmpCounter++}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    // Record what we just published so the next read does not re-parse our own
    // write; anything else changing the file makes the signature differ again.
    this.signature = this.fileSignature();
  }

  private pruneExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
      if (record.expiresAt < now) delete this.state.refreshTokens[hash];
    }
    for (const [hash, record] of Object.entries(this.state.consumedRefreshTokens)) {
      if (record.expiresAt < now) delete this.state.consumedRefreshTokens[hash];
    }
    for (const [id, record] of Object.entries(this.state.apiTokens)) {
      if (record.expiresAt < now) delete this.state.apiTokens[id];
    }
  }

  get cookieSecret(): string {
    this.reloadIfChanged();
    return this.state.cookieSecret;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    this.reloadIfChanged();
    return this.state.clients[clientId];
  }

  listClients(): Record<string, OAuthClientInformationFull> {
    this.reloadIfChanged();
    return structuredClone(this.state.clients);
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.mutate(() => {
      this.state.clients[client.client_id] = client;
      this.pruneUnapprovedClients();
    });
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
    this.reloadIfChanged();
    return this.state.approvals[clientId];
  }

  /** Records consent for one client; a client may legitimately use several
   *  redirect URIs, so they accumulate rather than replace each other. */
  saveApproval(clientId: string, redirectUri: string, clientName?: string): void {
    this.mutate(() => {
      const existing = this.state.approvals[clientId];
      const redirectUris = existing ? [...new Set([...existing.redirectUris, redirectUri])] : [redirectUri];
      this.state.approvals[clientId] = {
        redirectUris,
        clientName: clientName ?? existing?.clientName,
        approvedAt: existing?.approvedAt ?? Math.floor(Date.now() / 1000)
      };
    });
  }

  listApprovals(): Record<string, ClientApproval> {
    this.reloadIfChanged();
    return structuredClone(this.state.approvals);
  }

  revokeApproval(clientId: string): void {
    this.revokeClientAccess(clientId);
  }

  getRevokedBefore(clientId: string): number | undefined {
    this.reloadIfChanged();
    return this.state.revokedBefore[clientId];
  }

  /**
   * Immediately withdraw every grant for one client. Access JWTs are rejected
   * using revokedBefore, while every active refresh token is removed from
   * disk. The client registration stays so it can go through consent again.
   */
  revokeClientAccess(clientId: string): { refreshTokens: number; revokedBefore: number } {
    return this.mutate(() => {
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
      return { refreshTokens, revokedBefore };
    });
  }

  private static hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  saveRefreshToken(token: string, record: RefreshTokenRecord): void {
    this.mutate(() => {
      this.state.refreshTokens[AuthStore.hash(token)] = record;
    });
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    this.reloadIfChanged();
    const record = this.state.refreshTokens[AuthStore.hash(token)];
    if (record && record.expiresAt < Math.floor(Date.now() / 1000)) return undefined;
    return record;
  }

  deleteRefreshToken(token: string): void {
    this.mutate(() => {
      delete this.state.refreshTokens[AuthStore.hash(token)];
    });
  }

  /**
   * Rotation step: the token is invalidated but remembered, so that a replay
   * of an already-rotated token can be told apart from a merely unknown one.
   */
  consumeRefreshToken(token: string, familyId: string, expiresAt: number): void {
    this.mutate(() => {
      delete this.state.refreshTokens[AuthStore.hash(token)];
      this.state.consumedRefreshTokens[AuthStore.hash(token)] = { familyId, expiresAt };
    });
  }

  wasConsumed(token: string): ConsumedRefreshToken | undefined {
    this.reloadIfChanged();
    return this.state.consumedRefreshTokens[AuthStore.hash(token)];
  }

  /** A replayed refresh token means the chain leaked; drop every token of it. */
  revokeFamily(familyId: string): number {
    return this.mutate(() => {
      let revoked = 0;
      for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
        if (record.familyId === familyId) {
          delete this.state.refreshTokens[hash];
          revoked++;
        }
      }
      return revoked;
    });
  }

  saveApiToken(id: string, record: ApiTokenRecord): void {
    this.mutate(() => {
      this.state.apiTokens[id] = record;
    });
  }

  /** Undefined for unknown, revoked or expired ids — all three mean "refuse". */
  getApiToken(id: string): ApiTokenRecord | undefined {
    this.reloadIfChanged();
    const record = this.state.apiTokens[id];
    if (record && record.expiresAt < Math.floor(Date.now() / 1000)) return undefined;
    return record;
  }

  listApiTokens(): Record<string, ApiTokenRecord> {
    this.reloadIfChanged();
    return structuredClone(this.state.apiTokens);
  }

  /** Deleting the record is the revocation: verification refuses unknown ids. */
  revokeApiToken(id: string): boolean {
    // reloadIfChanged() before the existence check, so revoking a token another
    // process minted seconds ago reports true instead of "no such id".
    this.reloadIfChanged();
    if (!this.state.apiTokens[id]) return false;
    return this.mutate(() => {
      delete this.state.apiTokens[id];
      return true;
    });
  }
}
