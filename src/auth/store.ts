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

/**
 * What the hub knows about a dynamic registration beyond its OAuth metadata:
 * when it was last used, and the credential that lets the client manage its own
 * registration (RFC 7592).
 *
 * Deliberately kept out of the client record itself. That record is handed to
 * the SDK, echoed back to the client and read by the admin CLI, and the one
 * thing in here that must never leave the hub is the token hash.
 */
export interface ClientLifecycle {
  /** sha256 of the RFC 7592 registration access token, when the client has one. */
  registrationTokenHash?: string;
  /** Epoch seconds. Registering counts, and so does every later use. */
  lastActiveAt: number;
  /**
   * Created by the operator with `mcp-hub-admin clients add`, not by a client
   * registering itself.
   *
   * Exempt from every lifecycle rule below. Those rules exist because anyone
   * may register; a client the operator typed out by hand is the opposite case,
   * and having it disappear after ninety idle days — or be evicted to make room
   * for a stranger — would be a surprise with no upside.
   */
  operatorManaged?: boolean;
}

export interface ClientLimits {
  /** Hard ceiling on stored registrations. */
  maxClients: number;
  /** How long a registration may sit without ever being approved. */
  pendingTtlSeconds: number;
  /** How long a registration may sit unused before it is forgotten. */
  inactiveSeconds: number;
}

export const DEFAULT_CLIENT_LIMITS: ClientLimits = {
  maxClients: 500,
  pendingTtlSeconds: 24 * 3600,
  inactiveSeconds: 90 * 86_400
};

/**
 * What the hub holds to authenticate itself *to* one upstream MCP server.
 *
 * Unlike everything else in this file these are credentials to a third party,
 * so they are stored as they must be presented — in the clear. `state.json` is
 * already mode 0600 and already holds live secrets (`cookieSecret`, a
 * confidential client's `client_secret`), but this raises what a copy of the
 * file is worth; `docs/guide/security.md` says so explicitly.
 */
export interface UpstreamCredentials {
  /**
   * Hash over the identity-defining config fields. When the operator points a
   * server at a different URL, client or scope set, the old tokens describe an
   * identity that no longer exists and must not be presented. Same idea as
   * ToolCache's fingerprint, and for the same reason.
   */
  fingerprint: string;
  /** Assigned by DCR, the document URL for CIMD, or copied from the config for static. */
  clientId?: string;
  clientSecret?: string;
  /** RFC 7592 credential, when the upstream issued one at dynamic registration. */
  registrationAccessToken?: string;
  registrationClientUri?: string;
  /** Exactly the SDK's OAuthTokens shape, stored verbatim. */
  tokens?: Record<string, unknown>;
  /** Absolute expiry of the access token, epoch seconds. Deliberately NOT named
   *  `expiresAt`: pruneExpired() would drop the whole record while the refresh
   *  token behind it is still good. */
  accessTokenValidUntil?: number;
  /** Cached RFC 9728 / RFC 8414 discovery, so a restart does not re-derive it. */
  discovery?: Record<string, unknown>;
  obtainedAt: number; // epoch seconds
}

/** One authorization-code login in flight, keyed by its signed `state`. */
export interface UpstreamLogin {
  serverName: string;
  codeVerifier: string;
  /** Where the code must be redeemed; captured when the login was started so
   *  the callback does not have to discover it again. */
  authorizationServerUrl: string;
  resourceMetadataUrl?: string;
  scope?: string;
  expiresAt: number; // epoch seconds — swept by pruneExpired()
}

/** What a prune removed, or would remove. */
export interface ClientPruneResult {
  /** Registered, never approved, and the window has passed. */
  pending: string[];
  /** Approved once, but unused for too long. */
  inactive: string[];
}

/**
 * Activity is only written to disk once an hour. The windows it feeds are a day
 * and three months, so recording it per request would buy nothing and cost a
 * lock plus a full rewrite of state.json on every authorization.
 */
const ACTIVITY_GRANULARITY_S = 3600;

/**
 * A revocation marker only has to outlive the longest-lived token it could
 * still reject. Refresh tokens last 30 days, so anything older is answering a
 * question nobody can ask any more — and without this the map is the one
 * structure that only ever grows.
 */
const REVOCATION_MARKER_TTL_MS = 31 * 24 * 3600_000;

interface PersistedState {
  cookieSecret: string;
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshTokenRecord>; // keyed by sha256(token)
  approvals: Record<string, ClientApproval>; // keyed by client_id
  consumedRefreshTokens: Record<string, ConsumedRefreshToken>; // keyed by sha256(token)
  revokedBefore: Record<string, number>; // client_id -> epoch milliseconds
  apiTokens: Record<string, ApiTokenRecord>; // keyed by token id (jti)
  clientLifecycle: Record<string, ClientLifecycle>; // keyed by client_id
  upstreamCredentials: Record<string, UpstreamCredentials>; // keyed by server name
  upstreamLogins: Record<string, UpstreamLogin>; // keyed by the signed OAuth state
  /** The issuer the hub last ran under, so `mcp-hub-admin upstream login` can
   *  build a redirect URI without EXTERNAL_URL being set in its environment —
   *  the Dockerfile sets only CONFIG_PATH and DATA_PATH. */
  externalUrl?: string;
}

/**
 * Registration is open (anyone can POST /register), so unconfirmed clients
 * would otherwise accumulate on disk without bound and every registration
 * rewrites state.json whole. Cap the number of clients that were never
 * approved; approved ones are legitimate and never evicted.
 */
export const MAX_UNAPPROVED_CLIENTS = 100;

/**
 * The same limits the hub runs with, so `mcp-hub-admin clients prune` removes
 * exactly what the hub would. The documented invocation is `docker exec` into
 * the hub container, which shares its environment.
 */
export function clientLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientLimits {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      console.warn(`mcp-hub: ignoring ${name}=${raw}; it must be a positive integer`);
      return fallback;
    }
    return value;
  };
  return {
    maxClients: read('DCR_MAX_CLIENTS', 500),
    pendingTtlSeconds: read('DCR_PENDING_TTL_HOURS', 24) * 3600,
    inactiveSeconds: read('DCR_INACTIVE_DAYS', 90) * 86_400
  };
}
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 10;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

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
  private readonly lockPath: string;
  private readonly upstreamKeyPath: string;
  private cachedUpstreamKey?: crypto.KeyObject;
  /** Identity of the file contents this.state was loaded from; see fileSignature(). */
  private signature?: string;
  private tmpCounter = 0;

  constructor(
    dataDir: string,
    private readonly limits: ClientLimits = DEFAULT_CLIENT_LIMITS
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, 'state.json');
    this.lockPath = path.join(dataDir, '.auth-state.lock');
    this.upstreamKeyPath = path.join(dataDir, 'upstream-key.pem');
    this.acquireLock();
    try {
      const keyPath = path.join(dataDir, 'jwt-key.pem');
      if (!fs.existsSync(keyPath)) {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      }
      this.privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
      this.publicKey = crypto.createPublicKey(this.privateKey);

      const restored = AuthStore.readState(this.statePath);
      this.state = restored ?? {
        cookieSecret: crypto.randomBytes(32).toString('base64url'),
        clients: {},
        refreshTokens: {},
        approvals: {},
        consumedRefreshTokens: {},
        revokedBefore: {},
        apiTokens: {},
        clientLifecycle: {},
        upstreamCredentials: {},
        upstreamLogins: {}
      };
      if (restored) this.signature = this.fileSignature();
      else this.persistUnlocked();
    } finally {
      this.releaseLock();
    }
  }

  /** Atomic directory creation is the portable cross-process mutex. */
  private acquireLock(): void {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        fs.writeFileSync(path.join(this.lockPath, 'owner'), `${process.pid}\n`, { mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.removeStaleLock();
      if (Date.now() >= deadline) throw new Error(`timed out waiting for auth state lock ${this.lockPath}`);
      Atomics.wait(lockSleep, 0, 0, LOCK_POLL_MS);
    }
  }

  /**
   * Break a lock whose owner is gone.
   *
   * The owner's pid is the precise signal and is used whenever it can be read.
   * Age is the fallback, and it has to be one: the directory is created before
   * the owner file is written, so a process killed between the two leaves a
   * lock nobody can attribute. Treating that as "held" would wedge every
   * future AuthStore in the data directory until someone deleted it by hand.
   *
   * The pid also means nothing across a PID namespace — an admin CLI installed
   * from npm on the host, against a /data volume the hub uses from inside a
   * container. The documented invocation is `docker exec` into the hub, which
   * shares the namespace; for the other case the age fallback is what applies.
   */
  private removeStaleLock(): void {
    try {
      const stat = fs.statSync(this.lockPath);
      const pid = this.lockOwnerPid();
      if (pid !== undefined) {
        try {
          process.kill(pid, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        }
      } else if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) {
        return;
      }
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // The owner may have released it between stat and read. Retry mkdir.
    }
  }

  /** undefined when the owner file is missing, unreadable or not a pid. */
  private lockOwnerPid(): number | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.lockPath, 'owner'), 'utf8');
    } catch {
      return undefined;
    }
    const pid = Number(raw.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`mcp-hub: could not release auth state lock: ${(error as Error).message}`);
    }
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
    this.acquireLock();
    try {
      this.reloadUnderLock();
      const result = fn();
      this.persistUnlocked();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * A mutation must never proceed from stale memory, even if stat metadata is
   * unchanged. A file that is *gone* is not stale memory, though: the
   * constructor recreates it, and refusing here instead would turn a deleted
   * state.json into a hub whose every refresh-token rotation fails until it is
   * restarted. Unparseable content stays a hard error — that is a file with
   * contents we cannot merge into, and overwriting it would drop grants.
   */
  private reloadUnderLock(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error('mcp-hub: auth state file is gone, writing the state in memory back to disk');
        this.persistUnlocked();
        return;
      }
      throw new Error(`cannot reload auth state while holding the mutation lock: ${(error as Error).message}`);
    }
    const next = AuthStore.normalize(parsed);
    if (!next) throw new Error('cannot mutate unusable auth state');
    this.state = next;
    this.signature = this.fileSignature();
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
      apiTokens: state.apiTokens ?? {},
      clientLifecycle: state.clientLifecycle ?? {},
      upstreamCredentials: state.upstreamCredentials ?? {},
      upstreamLogins: state.upstreamLogins ?? {},
      ...(typeof state.externalUrl === 'string' ? { externalUrl: state.externalUrl } : {})
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

  private persistUnlocked(): void {
    this.pruneExpired();
    // Per-writer temporary name plus atomic rename keeps readers from observing
    // a half-written file. Mutations are serialized by the cross-process lock,
    // so this write also cannot overwrite another process's newer state.
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
    // A marker that can no longer reject anything is just a row that never
    // goes away; this is otherwise the one map with no upper bound.
    const markerCutoff = Date.now() - REVOCATION_MARKER_TTL_MS;
    for (const [clientId, revokedAt] of Object.entries(this.state.revokedBefore)) {
      if (revokedAt < markerCutoff) delete this.state.revokedBefore[clientId];
    }
    // Bookkeeping for a client that is gone serves nobody.
    for (const clientId of Object.keys(this.state.clientLifecycle)) {
      if (!this.state.clients[clientId]) delete this.state.clientLifecycle[clientId];
    }
    // A login nobody finished. Note this sweeps only the in-flight record —
    // UpstreamCredentials deliberately has no `expiresAt`, because an expired
    // access token still has a usable refresh token behind it.
    for (const [state, login] of Object.entries(this.state.upstreamLogins)) {
      if (login.expiresAt < now) delete this.state.upstreamLogins[state];
    }
  }

  // --- Upstream OAuth ------------------------------------------------------

  /** The issuer the hub is running under, recorded so the admin CLI can build a
   *  redirect URI without EXTERNAL_URL in its own environment. */
  rememberExternalUrl(externalUrl: string): void {
    this.reloadIfChanged();
    if (this.state.externalUrl === externalUrl) return;
    this.mutate(() => {
      this.state.externalUrl = externalUrl;
    });
  }

  getExternalUrl(): string | undefined {
    this.reloadIfChanged();
    return this.state.externalUrl;
  }

  /**
   * What the hub holds for one upstream, or undefined when there is nothing —
   * including when the configuration moved out from under it, which is what the
   * fingerprint detects. Stale credentials are not returned and not deleted:
   * deleting on a read would race the admin CLI, and the next successful login
   * overwrites them anyway.
   */
  getUpstreamCredentials(serverName: string, fingerprint: string): UpstreamCredentials | undefined {
    this.reloadIfChanged();
    const record = this.state.upstreamCredentials[serverName];
    if (!record || record.fingerprint !== fingerprint) return undefined;
    return structuredClone(record);
  }

  /** Every stored upstream, whatever its fingerprint — for `upstream list`. */
  listUpstreamCredentials(): Record<string, UpstreamCredentials> {
    this.reloadIfChanged();
    return structuredClone(this.state.upstreamCredentials);
  }

  /**
   * Read-modify-write of one upstream's record. The callback runs while the
   * cross-process lock is held, so it must not do I/O — it gets the current
   * record (or undefined) and returns the one to store.
   */
  updateUpstreamCredentials(serverName: string, update: (current: UpstreamCredentials | undefined) => UpstreamCredentials): void {
    this.mutate(() => {
      this.state.upstreamCredentials[serverName] = update(this.state.upstreamCredentials[serverName]);
    });
  }

  forgetUpstreamCredentials(serverName: string): boolean {
    return this.mutate(() => {
      if (!this.state.upstreamCredentials[serverName]) return false;
      delete this.state.upstreamCredentials[serverName];
      return true;
    });
  }

  saveUpstreamLogin(state: string, login: UpstreamLogin): void {
    this.mutate(() => {
      this.state.upstreamLogins[state] = login;
    });
  }

  listUpstreamLogins(): Record<string, UpstreamLogin> {
    this.reloadIfChanged();
    return structuredClone(this.state.upstreamLogins);
  }

  /** Single-use: the record is removed as it is read, so a replayed callback
   *  finds nothing even if the signed state is still within its lifetime. */
  takeUpstreamLogin(state: string): UpstreamLogin | undefined {
    return this.mutate(() => {
      const login = this.state.upstreamLogins[state];
      if (!login) return undefined;
      delete this.state.upstreamLogins[state];
      return login.expiresAt < Math.floor(Date.now() / 1000) ? undefined : login;
    });
  }

  /**
   * The key the hub signs outbound `private_key_jwt` assertions with.
   *
   * Deliberately *not* `jwt-key.pem`: that one signs access tokens the hub
   * issues to its own clients, and a key that both mints local credentials and
   * proves identity to a third party is one key doing two jobs. Created on
   * first use, because most deployments never need it.
   */
  get upstreamPrivateKey(): crypto.KeyObject {
    if (!this.cachedUpstreamKey) {
      if (!fs.existsSync(this.upstreamKeyPath)) {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        fs.writeFileSync(this.upstreamKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      }
      this.cachedUpstreamKey = crypto.createPrivateKey(fs.readFileSync(this.upstreamKeyPath, 'utf8'));
    }
    return this.cachedUpstreamKey;
  }

  /** The lifecycle limits this store was built with, for callers that need to
   *  report them. */
  get clientLimits(): ClientLimits {
    return this.limits;
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
   * Records a newly registered client, or answers false when the hub is full.
   *
   * Full means the ceiling is reached and every registration under it has been
   * approved. Making room by dropping one of those would take a connector
   * somebody is using offline — and an attacker who can register at will would
   * be able to aim that at a specific victim. Refusing the newcomer is the
   * failure the operator can see and fix.
   */
  addClient(
    client: OAuthClientInformationFull,
    registrationToken?: string,
    options: { operatorManaged?: boolean } = {}
  ): boolean {
    return this.mutate(() => {
      this.pruneUnderLock();
      // An operator-created client is not subject to the ceiling either: it was
      // asked for deliberately, and refusing it would be refusing the person
      // who administers the hub.
      if (!options.operatorManaged && !this.makeRoomForOneClient()) return false;
      this.state.clients[client.client_id] = client;
      this.state.clientLifecycle[client.client_id] = {
        ...(registrationToken ? { registrationTokenHash: AuthStore.hash(registrationToken) } : {}),
        ...(options.operatorManaged ? { operatorManaged: true } : {}),
        lastActiveAt: Math.floor(Date.now() / 1000)
      };
      this.pruneUnapprovedClients();
      return true;
    });
  }

  /** True for a client the operator created by hand. */
  isOperatorManaged(clientId: string): boolean {
    this.reloadIfChanged();
    return this.state.clientLifecycle[clientId]?.operatorManaged === true;
  }

  /** Evicts never-approved registrations until one more fits, and reports
   *  whether it managed to. */
  private makeRoomForOneClient(): boolean {
    const fits = () => Object.keys(this.state.clients).length < this.limits.maxClients;
    if (fits()) return true;
    const evictable = Object.values(this.state.clients)
      .filter(candidate => !this.state.approvals[candidate.client_id] && !this.isOperatorManagedUnderLock(candidate.client_id))
      .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
    for (const candidate of evictable) {
      this.forgetClient(candidate.client_id);
      if (fits()) return true;
    }
    return fits();
  }

  /** RFC 7592 update. Changing the redirect URIs withdraws the approval: it was
   *  given for a specific destination, and the client does not get to move that
   *  destination afterwards without being asked again. */
  updateClient(client: OAuthClientInformationFull, options: { resetApproval?: boolean } = {}): void {
    this.mutate(() => {
      if (!this.state.clients[client.client_id]) return;
      this.state.clients[client.client_id] = client;
      if (options.resetApproval) delete this.state.approvals[client.client_id];
    });
  }

  /** Removes a registration outright — the client, its approval, its refresh
   *  tokens and, so live access tokens stop working now rather than in fifteen
   *  minutes, a revocation marker. */
  deleteClient(clientId: string): boolean {
    return this.mutate(() => {
      if (!this.state.clients[clientId] && !this.state.approvals[clientId]) return false;
      this.forgetClient(clientId);
      delete this.state.approvals[clientId];
      for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
        if (record.clientId === clientId) delete this.state.refreshTokens[hash];
      }
      this.state.revokedBefore[clientId] = Date.now();
      return true;
    });
  }

  /** The same question as isOperatorManaged(), for a caller that already holds
   *  the lock and must not re-read the file underneath itself. */
  private isOperatorManagedUnderLock(clientId: string): boolean {
    return this.state.clientLifecycle[clientId]?.operatorManaged === true;
  }

  private forgetClient(clientId: string): void {
    delete this.state.clients[clientId];
    delete this.state.clientLifecycle[clientId];
  }

  /** Notes that a client was used. Cheap to call on every request: it only
   *  reaches the disk once an hour, and never fails the caller. */
  touchClient(clientId: string): void {
    try {
      this.reloadIfChanged();
      const entry = this.state.clientLifecycle[clientId];
      if (!entry) return; // a metadata-document client has no registration to age
      const now = Math.floor(Date.now() / 1000);
      if (now - entry.lastActiveAt < ACTIVITY_GRANULARITY_S) return;
      this.mutate(() => {
        const current = this.state.clientLifecycle[clientId];
        if (current) current.lastActiveAt = now;
      });
    } catch (error) {
      // Bookkeeping must never be the reason an authorization fails.
      console.warn(`mcp-hub: could not record activity for client ${clientId}: ${(error as Error).message}`);
    }
  }

  /** Timing-safe check of an RFC 7592 registration access token. */
  verifyRegistrationToken(clientId: string, token: string): boolean {
    this.reloadIfChanged();
    const expected = this.state.clientLifecycle[clientId]?.registrationTokenHash;
    if (!expected) return false;
    const given = AuthStore.hash(token);
    return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  /** What a prune would remove right now, without removing it. */
  planClientPrune(): ClientPruneResult {
    this.reloadIfChanged();
    const { pending, inactive } = this.classifyClients();
    return { pending, inactive };
  }

  /**
   * Drops registrations that were never confirmed and ones nobody has used in
   * a long time. Only touches disk when there is something to do.
   *
   * Metadata-document clients are unaffected: they are never stored here, so
   * the approval that is their only trace is left alone.
   */
  pruneClients(): ClientPruneResult {
    this.reloadIfChanged();
    const preview = this.classifyClients();
    if (preview.pending.length === 0 && preview.inactive.length === 0 && preview.undated.length === 0) {
      return { pending: [], inactive: [] };
    }
    return this.mutate(() => this.pruneUnderLock());
  }

  private classifyClients(): { pending: string[]; inactive: string[]; undated: string[] } {
    const now = Math.floor(Date.now() / 1000);
    const pending: string[] = [];
    const inactive: string[] = [];
    const undated: string[] = [];
    for (const clientId of Object.keys(this.state.clients)) {
      const lifecycle = this.state.clientLifecycle[clientId];
      if (!lifecycle) {
        undated.push(clientId);
        continue;
      }
      if (lifecycle.operatorManaged) continue;
      const idle = now - lifecycle.lastActiveAt;
      if (!this.state.approvals[clientId]) {
        if (idle >= this.limits.pendingTtlSeconds) pending.push(clientId);
      } else if (idle >= this.limits.inactiveSeconds) {
        inactive.push(clientId);
      }
    }
    return { pending, inactive, undated };
  }

  /** The sweep itself. The only implementation, so a registration and the
   *  periodic pass cannot drift apart in what they clean up. */
  private pruneUnderLock(): ClientPruneResult {
    const { pending, inactive, undated } = this.classifyClients();
    // A state file written before activity was tracked has no clock for its
    // clients. Starting that clock now, rather than reading it as "idle since
    // registration", is what stops an upgrade from deleting every connector
    // that happens to predate the inactivity window.
    const now = Math.floor(Date.now() / 1000);
    for (const clientId of undated) this.state.clientLifecycle[clientId] = { lastActiveAt: now };
    for (const clientId of pending) this.forgetClient(clientId);
    for (const clientId of inactive) {
      this.forgetClient(clientId);
      delete this.state.approvals[clientId];
      for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
        if (record.clientId === clientId) delete this.state.refreshTokens[hash];
      }
    }
    return { pending, inactive };
  }

  /**
   * Evict the oldest never-approved clients once too many pile up. A client
   * with an approval entry is one the operator confirmed and is kept; the just
   * -registered client is the newest and therefore survives its own eviction.
   */
  private pruneUnapprovedClients(): void {
    const unapproved = Object.values(this.state.clients)
      .filter(c => !this.state.approvals[c.client_id] && !this.isOperatorManagedUnderLock(c.client_id))
      .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
    for (let i = 0; i < unapproved.length - MAX_UNAPPROVED_CLIENTS; i++) {
      this.forgetClient(unapproved[i].client_id);
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
    return this.mutate(() => {
      if (!this.state.apiTokens[id]) return false;
      delete this.state.apiTokens[id];
      return true;
    });
  }
}
