/**
 * Preloaded into a spawned hub (NODE_OPTIONS=--require) to wedge its event loop
 * before it can answer anything — the one failure the readiness probe cannot
 * explain from the log, and what the stack capture in gateway.ts is for.
 */
setTimeout(function blockTheEventLoop() {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    // Busy on purpose: nothing else may run.
  }
}, 0);
