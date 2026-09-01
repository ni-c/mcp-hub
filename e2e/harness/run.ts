import { spawn } from 'node:child_process';

import { LogTail } from './logs.js';

/**
 * Runs a binary to completion and reports what it said and how it ended.
 *
 * For the cases where the interesting result is the exit code and a message on
 * stderr — a hub refusing to start, an admin command rejecting its arguments.
 * `startGateway` is the wrong tool for those: it waits for a hub to become
 * ready, and a hub that is supposed to die never will.
 *
 * The environment is not merged with `process.env`, the same rule the gateway
 * follows: a test of "what happens without EXTERNAL_URL" is worthless if the
 * shell happens to have one.
 */
export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Both streams in the order they arrived, for messages that span them. */
  output: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
}

export async function runToCompletion(entry: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const combined = new LogTail();
  const out = new LogTail();
  const err = new LogTail();
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? '', ...options.env },
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
  child.stdout?.on('data', chunk => {
    out.push(String(chunk));
    combined.push(String(chunk));
  });
  child.stderr?.on('data', chunk => {
    err.push(String(chunk));
    combined.push(String(chunk));
  });
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);

  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise<RunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `mcp-hub e2e: ${entry} ${args.join(' ')} did not exit within ${timeoutMs}ms.\n` +
            `It said:\n${combined.text()}`
        )
      );
    }, timeoutMs);
    timer.unref();
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: out.text(), stderr: err.text(), output: combined.text() });
    });
  });
}
