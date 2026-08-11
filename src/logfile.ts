import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];

export interface FileLogger {
  /** Restores the original console methods and closes the file. */
  stop(): void;
}

/**
 * Mirrors everything the hub writes to the console into a log file, one line
 * per entry, prefixed with an ISO-8601 UTC timestamp.
 *
 * Why a file at all, when the container already writes to stdout/stderr: log
 * shippers that follow a file — fail2ban above all — need a stable path. The
 * Docker json-file path contains the container ID and changes on every
 * recreate, and the journald driver maps *all* stderr to priority `err`, which
 * makes every ordinary log line of an MCP server (which must keep stdout free
 * for the protocol, so it logs to stderr) look like a system error.
 *
 * The console output itself is left untouched, so `docker logs` keeps working.
 * Logging must never take the hub down: a file that cannot be written is
 * reported once and then ignored.
 */
export function installFileLogging(filePath: string): FileLogger {
  const original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
  let stream: fs.WriteStream | undefined;
  let broken = false;

  const fail = (message: string) => {
    if (broken) return;
    broken = true;
    // Deliberately the original method: the wrapper would recurse.
    (original.error ?? console.error)(`mcp-hub: file logging to ${filePath} disabled: ${message}`);
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', error => fail(error.message));
  } catch (error) {
    fail((error as Error).message);
  }

  for (const method of METHODS) {
    // The raw reference, not a bound copy: stop() has to be able to restore the
    // exact same function, and repeated install/stop cycles must not stack
    // wrappers on top of each other.
    const previous = console[method] as (...args: unknown[]) => void;
    original[method] = previous;
    console[method] = (...args: unknown[]) => {
      previous.apply(console, args);
      if (broken || !stream) return;
      const timestamp = new Date().toISOString();
      // Prefix every line, so a multi-line entry (a stack trace) never leaves a
      // dateless line behind for a log parser to guess at.
      const text = format(...args)
        .split('\n')
        .map(line => `${timestamp} ${line}`)
        .join('\n');
      stream.write(`${text}\n`);
    };
  }

  return {
    stop() {
      for (const method of METHODS) {
        const previous = original[method];
        if (previous) console[method] = previous as typeof console.log;
      }
      stream?.end();
      stream = undefined;
    }
  };
}
