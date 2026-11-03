import { operatorCredential } from './password.js';
import type { OperatorCredential } from './password.js';
import { LoginRateLimiter } from './rate-limit.js';
import type { AuthStore } from './store.js';
import { logSafe } from './text.js';
import { parseTotpSecret, verifyTotp } from './totp.js';

export type TwoFactorMode = 'off' | 'totp';
export const TWO_FACTOR_MODES: readonly TwoFactorMode[] = ['off', 'totp'];

export interface OperatorFactorsOptions {
  password?: string;
  passwordHash?: string;
  twoFactor?: TwoFactorMode;
  totpSecret?: string;
}

export type FactorVerdict =
  | { outcome: 'ok'; amr: string[] }
  | { outcome: 'disabled' }
  | { outcome: 'rate_limited' }
  | { outcome: 'paused'; retryAfterSeconds: number }
  | { outcome: 'bad_password' }
  | { outcome: 'bad_code' }
  | { outcome: 'replayed_code' };

const PAUSE_AFTER_FAILURES = 5;
const PAUSE_BASE_MS = 30_000;
const PAUSE_MAX_MS = 60 * 60_000;

/** Pause after wrong codes: none for four, then 30 s doubling up to an hour. */
export function pauseFor(failures: number): number {
  if (failures < PAUSE_AFTER_FAILURES) return 0;
  return Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** (failures - PAUSE_AFTER_FAILURES));
}

/** What the operator proves at a sign-in or an unlock. */
export class OperatorFactors {
  readonly mode: TwoFactorMode;
  readonly enabled: boolean;
  readonly problem?: string;
  readonly amr: readonly string[];
  private readonly credential: OperatorCredential;
  private readonly totpKey?: Buffer;
  private codeFailures = 0;
  private pausedUntil = 0;

  constructor(
    options: OperatorFactorsOptions,
    private readonly store: AuthStore,
    readonly limiter: LoginRateLimiter = new LoginRateLimiter()
  ) {
    const mode = options.twoFactor ?? 'off';
    if (!TWO_FACTOR_MODES.includes(mode)) throw new Error(`twoFactor must be one of ${TWO_FACTOR_MODES.join(', ')}`);
    this.mode = mode;
    this.credential = operatorCredential(options);
    this.amr = mode === 'totp' ? ['pwd', 'otp', 'mfa'] : ['pwd'];
    const secret = mode === 'totp' ? parseTotpSecret(options.totpSecret) : {};
    this.totpKey = secret.key;
    const problem = this.credential.problem ?? (secret.problem ? `TWO_FACTOR=totp but ${secret.problem} — the operator login is disabled, no client can be approved` : undefined);
    this.enabled = problem === undefined;
    if (problem !== undefined) this.problem = problem;
  }

  get requiresCode(): boolean {
    return this.mode === 'totp';
  }

  verify(ip: string, input: { password?: unknown; code?: unknown }, now = Date.now()): FactorVerdict {
    if (!this.enabled) return { outcome: 'disabled' };
    if (this.limiter.isBlocked(ip)) {
      console.warn(`mcp-hub: login rate limit exceeded from ${logSafe(ip)}`);
      return { outcome: 'rate_limited' };
    }
    const passwordOk = typeof input.password === 'string' && this.credential.check(input.password);
    const paused = this.requiresCode && now < this.pausedUntil;
    if (!passwordOk) {
      this.limiter.recordFailure(ip);
      console.warn(`mcp-hub: authentication failure from ${logSafe(ip)}`);
      return paused ? this.pauseVerdict(now) : { outcome: 'bad_password' };
    }
    if (paused) {
      console.warn(`mcp-hub: refused a sign-in while the second factor is paused, attempt from ${logSafe(ip)}`);
      return this.pauseVerdict(now);
    }
    if (this.requiresCode) {
      const step = typeof input.code === 'string' && this.totpKey ? verifyTotp(this.totpKey, input.code, now) : undefined;
      if (step === undefined) {
        this.codeFailures++;
        this.pausedUntil = now + pauseFor(this.codeFailures);
        console.warn(`mcp-hub: second-factor failure from ${logSafe(ip)}`);
        return { outcome: 'bad_code' };
      }
      if (!this.store.acceptTotpStep(step)) {
        console.warn(`mcp-hub: second-factor code reused, attempt from ${logSafe(ip)}`);
        return { outcome: 'replayed_code' };
      }
    }
    this.codeFailures = 0;
    this.pausedUntil = 0;
    this.limiter.reset(ip);
    return { outcome: 'ok', amr: [...this.amr] };
  }

  private pauseVerdict(now: number): FactorVerdict {
    return { outcome: 'paused', retryAfterSeconds: Math.max(1, Math.ceil((this.pausedUntil - now) / 1000)) };
  }
}
