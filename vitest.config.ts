import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // admin.ts is a CLI script: it reads process.argv and calls process.exit
      // at the top level, so importing it would run it. What it actually does
      // lives in AuthStore, which is covered directly.
      // index.ts deliberately stays in even though its isMain bootstrap block
      // (env parsing, listen, signal handlers) is never entered under test and
      // is the single largest gap in the numbers below — createHub() is in the
      // same file and is exercised by most of the suite.
      // docker-proxy/index.ts is the same kind of file as admin.ts: an entry
      // point whose body runs on import (env, config load, listen, exit). What
      // it wires together — policy.ts, secrets.ts, server.ts — is covered
      // directly, including against a real daemon.
      exclude: ['src/admin.ts', 'src/docker-proxy/index.ts'],
      // Measured 2026-08-25: 86.54 / 80.13 / 85.97 / 90.07. Set just below,
      // with headroom on functions. Raise them when the measurement rises;
      // answer a drop with tests, never by lowering the gate.
      thresholds: {
        statements: 86,
        branches: 79,
        functions: 84,
        lines: 90
      }
    }
  }
});
