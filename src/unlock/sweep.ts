import type { AuthStore } from '../auth/store.js';
import type { ManagedServer } from '../supervisor.js';
import { locksWholeServer } from './policy.js';

/** How long a lock waits for running calls. */
export const IN_FLIGHT_GRACE_MS = 5 * 60_000;

/** Recycles a whole-locked child once its last unlock has ended. */
export class UnlockSweep {
  private timer?: NodeJS.Timeout;
  private readonly open = new Set<string>();
  private running = false;
  private again = false;

  constructor(
    private readonly options: {
      store: AuthStore;
      server: (name: string) => ManagedServer | undefined;
      intervalMs: number;
      graceMs?: number;
    }
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Look now rather than at the next interval. */
  poke(): void {
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      const live = this.liveServers();
      for (const name of Array.from(this.open)) {
        if (live.has(name)) continue;
        this.open.delete(name);
        const managed = this.options.server(name);
        if (!managed || !locksWholeServer(managed.config.unlock)) continue;
        await managed.whenIdle(this.options.graceMs ?? IN_FLIGHT_GRACE_MS);
        if (this.liveServers().has(name)) {
          this.open.add(name);
          continue;
        }
        const outcome = await managed.recycle();
        console.log(`mcp-hub: [${name}] last unlock ended — ${outcome === 'slept' ? 'put to sleep' : outcome === 'restarted' ? 'restarted' : 'nothing held open'}`);
      }
      for (const name of live) this.open.add(name);
    } catch (error) {
      console.error(`mcp-hub: unlock sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.tick();
      }
    }
  }

  private liveServers(): Set<string> {
    return new Set(this.options.store.unlockGrants().map(grant => grant.server));
  }
}
