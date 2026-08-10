import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // epoch seconds
}

interface PersistedState {
  cookieSecret: string;
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshTokenRecord>; // keyed by sha256(token)
}

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
    if (fs.existsSync(this.statePath)) {
      this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedState;
    } else {
      this.state = { cookieSecret: crypto.randomBytes(32).toString('base64url'), clients: {}, refreshTokens: {} };
      this.persist();
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
  }

  get cookieSecret(): string {
    return this.state.cookieSecret;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.state.clients[client.client_id] = client;
    this.persist();
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
}
