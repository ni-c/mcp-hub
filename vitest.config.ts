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
      exclude: ['src/admin.ts'],
      // Measured 2026-08-17: 83.60 / 75.07 / 84.54 / 87.97. Set just below,
      // with headroom on functions. Raise them when the measurement rises;
      // answer a drop with tests, never by lowering the gate.
      thresholds: {
        statements: 82,
        branches: 73,
        functions: 79,
        lines: 86
      }
    }
  }
});
