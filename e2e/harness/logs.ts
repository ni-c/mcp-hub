import type { Readable } from 'node:stream';

/**
 * Everything a hub said, kept so a failure can say it too.
 *
 * The single best idea in `mcp-integration-harness` is that a harness which
 * captures stderr and attaches it to every failure turns "Connection closed"
 * into a diagnosis. Its other rule is the one that makes the capture work at
 * all: attach the listener *before* connecting. A hub that refuses to start
 * writes its reason during startup and exits; a listener added after the first
 * failed request has already missed it, and what is left is a timeout with
 * nothing in it.
 */
export class LogTail {
  private readonly lines: string[] = [];
  private pending = '';
  private readonly waiters = new Set<{ pattern: RegExp; resolve: (line: string) => void }>();

  constructor(private readonly limit = 2_000) {}

  attach(stream: Readable | null | undefined): void {
    stream?.setEncoding('utf8');
    stream?.on('data', chunk => this.push(String(chunk)));
  }

  push(chunk: string): void {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const line of parts) this.record(line);
  }

  private record(line: string): void {
    this.lines.push(line);
    // A crash-looping child can produce thousands of lines; the interesting
    // ones are the first (why it will not start) and the last (what it was
    // doing). Keeping a window of the most recent is the cheap approximation,
    // and the first are almost always still inside it because the loop is
    // slower than the buffer is long.
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    // A snapshot, because a matching waiter deletes itself from the set the
    // loop is walking.
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.pattern.test(line)) {
        this.waiters.delete(waiter);
        waiter.resolve(line);
      }
    }
  }

  text(): string {
    return this.pending ? [...this.lines, this.pending].join('\n') : this.lines.join('\n');
  }

  /** Every line so far that matches, for assertions about what was logged. */
  matching(pattern: RegExp): string[] {
    return this.lines.filter(line => pattern.test(line));
  }

  /**
   * Resolves with the first line to match, past or future.
   *
   * Past as well as future matters: a caller that triggers something and then
   * waits would otherwise race the line it triggered, and the race is lost
   * whenever the hub is quicker than the await — which is most of the time.
   */
  waitForLine(pattern: RegExp, timeoutMs = 10_000): Promise<string> {
    const already = this.lines.find(line => pattern.test(line));
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const waiter = { pattern, resolve };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`mcp-hub e2e: no log line matched ${pattern} within ${timeoutMs}ms.\n\n${this.text()}`));
      }, timeoutMs);
      timer.unref();
    });
  }
}

/**
 * Re-throws an error with the hub's output appended.
 *
 * Used by the gateway around anything that can fail while the hub is the
 * suspect. The original stack is kept — the point is to add the missing half of
 * the story, not to replace the half that is already there.
 */
export function decorate(error: unknown, what: string, output: string): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const trimmed = output.trim();
  original.message = trimmed
    ? `${original.message}\n\nWhile ${what}. The hub said:\n${indent(trimmed)}`
    : `${original.message}\n\nWhile ${what}. The hub said nothing at all.`;
  return original;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map(line => `  | ${line}`)
    .join('\n');
}
